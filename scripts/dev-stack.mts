// One worktree's dev stack: Postgres and Valkey in a compose project of its own, and the api,
// scheduler, worker and web on the host under turbo. Several worktrees run it at once. The two
// modes keep apart projects and state, so a fresh stack never touches the data `just dev` keeps.
//   node scripts/dev-stack.mts dev            keep this worktree's data across runs (`just dev`)
//   node scripts/dev-stack.mts fresh          start from the seed, delete the data on stop (`just dev-fresh`)
//   node scripts/dev-stack.mts down [mode]    stop one or both modes (`just dev-down` stops both)
//   node scripts/dev-stack.mts status <mode>  check the recorded orchestrator, exit 1 when stopped
//   node scripts/dev-stack.mts run -- <cmd>   run <cmd> against the databases of `just dev` (the db-* recipes)
// Plain Node runs this file, so it is the one process the recipe signals: on SIGTERM, SIGINT or
// SIGHUP it stops every process group it started and the containers, then exits. It also runs
// the stack's mail server, which keeps every invitation and reset mail in `mailbox` and prints it.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMailSink } from "../test/mail-sink.ts";
import type { CommandExit } from "./dev-stack-supervisor.mts";
import { stopTimeoutMs } from "./dev-stack-timeout.ts";
import { ensureEnvFile, secret } from "./env-file.ts";
import { processOwnerState, readProcessIdentity } from "./process-identity.ts";

/** `dev` keeps its data across runs; `fresh` starts from the seed and deletes its data on stop. */
type Mode = "dev" | "fresh";

/** What the recipe asked for. */
type Command =
  | { readonly kind: "start"; readonly mode: Mode }
  | { readonly kind: "down"; readonly modes: readonly Mode[] }
  | { readonly kind: "status"; readonly mode: Mode }
  | { readonly kind: "run"; readonly argv: readonly [string, ...string[]] };

/**
 * Where one worktree keeps the stack of one mode. Derived from the checkout path and the mode, so
 * it differs per worktree and per mode, and never matches the packaged stack's `swizzle-<hex>`.
 */
interface Worktree {
  readonly root: string;
  /** `git rev-parse --git-path <name>`: inside this worktree's own git directory. */
  readonly stateDirectory: string;
  /** The compose project name, `<name>-<dir>-<hash of the path>`. */
  readonly project: string;
}

/**
 * The per-user dev secrets, created once with fresh values in
 * `${XDG_CONFIG_HOME:-~/.config}/swizzle/dev.env` and shared by every worktree. Every other
 * variable in that file reaches the stack's processes too.
 */
type DevEnv = Readonly<Record<(typeof SECRET_NAMES)[number], string>> &
  Readonly<Record<string, string>>;

interface DatabasePorts {
  /** Assigned by Docker when the container starts, read back with `docker compose port`. */
  readonly postgres: number;
  readonly valkey: number;
}

interface Ports extends DatabasePorts {
  readonly api: number;
  /** The API's private listener for the local worker, as `local-worker-api` in the packaged stack. */
  readonly localWorker: number;
  readonly web: number;
}

/** A detached group's supervisor and OS start identity, checked before signalling the group. */
interface ProcessGroup {
  readonly pid: number;
  readonly incarnation: string;
}

/** `<stateDirectory>/stack.json`: what a driver reads to reach this worktree's stack. */
interface StackRecord {
  readonly project: string;
  readonly url: string;
  /** The dashboard on the tailnet, `https://<this host's tailnet name>:<web port>`, when published. */
  readonly tailnetUrl?: string;
  readonly apiUrl: string;
  readonly ports: Ports;
  /** Every mail the stack sent, appended as it goes out; invitation and reset links are in it. */
  readonly mailbox: string;
  readonly smtpUrl: string;
  /** The owner's login; `memberEmail` signs in with the same password and holds no grant. */
  readonly login: {
    readonly email: string;
    readonly memberEmail: string;
    readonly password: string;
  };
  /** The orchestrator and its process groups; `down` stops whichever is still alive. */
  readonly pid: number;
  readonly root: string;
  readonly incarnation: string;
  readonly groups: readonly ProcessGroup[];
}

const SECRET_NAMES = [
  "POSTGRES_PASSWORD",
  "VALKEY_PASSWORD",
  "SWIZZLE_ENCRYPTION_KEY",
  "SWIZZLE_DEV_OWNER_PASSWORD",
] as const;
const OWNER_EMAIL = "owner@swizzle.test";
const MEMBER_EMAIL = "member@swizzle.test";
/** The environment the api and scheduler serve and the dashboard opens, as in the packaged stack. */
const ENVIRONMENT = "staging";
const COMPOSE_FILE = "infra/docker/compose.dev.yml";
const READY_TIMEOUT_MS = 180_000;

function parseCommand(argv: readonly string[]): Command {
  const [verb, separator, ...rest] = argv;
  if (verb === "dev" || verb === "fresh") return { kind: "start", mode: verb };
  if (verb === "down" && rest.length === 0 && separator === undefined)
    return { kind: "down", modes: ["dev", "fresh"] };
  if (
    (verb === "down" || verb === "status") &&
    rest.length === 0 &&
    (separator === "dev" || separator === "fresh")
  ) {
    return verb === "down"
      ? { kind: "down", modes: [separator] }
      : { kind: "status", mode: separator };
  }
  const [program, ...args] = rest;
  if (verb === "run" && separator === "--" && program !== undefined) {
    return { kind: "run", argv: [program, ...args] };
  }
  throw new Error(
    "usage: node scripts/dev-stack.mts dev | fresh | down [dev|fresh] | status <dev|fresh> | run -- <command>",
  );
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** The name of each mode's project and state directory; both begin `swizzle-dev`. */
const NAMES = { dev: "swizzle-dev", fresh: "swizzle-dev-fresh" } as const satisfies Record<
  Mode,
  string
>;

function resolveWorktree(mode: Mode): Worktree {
  const root = git("rev-parse", "--show-toplevel");
  const directory = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-");
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return {
    project: `${NAMES[mode]}-${directory}-${hash}`,
    root,
    stateDirectory: git("rev-parse", "--path-format=absolute", "--git-path", NAMES[mode]),
  };
}

/** Creates the per-user dev.env once, then reads its required secrets without changing them. */
async function loadDevEnv(): Promise<DevEnv> {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const file = path.join(configHome, "swizzle", "dev.env");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const template = [
    "# Secrets of the swizzle dev stack (scripts/dev-stack.mts), shared by every worktree of this user.",
    "# Any other KEY=value line here reaches the api, scheduler, worker and web of `just dev` too.",
    ...SECRET_NAMES.map((name) => `${name}=`),
    "",
  ].join("\n");
  const { values } = await ensureEnvFile(
    file,
    template,
    Object.fromEntries(SECRET_NAMES.map((name) => [name, secret()])),
  );
  return values as DevEnv;
}

function compose(worktree: Worktree, env: DevEnv, args: readonly string[]): string {
  return execFileSync("docker", ["compose", "-p", worktree.project, "-f", COMPOSE_FILE, ...args], {
    cwd: worktree.root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Starts the containers, from empty volumes when fresh, and returns their host ports. */
function startDatabases(worktree: Worktree, env: DevEnv, fresh: boolean): DatabasePorts {
  if (fresh) compose(worktree, env, ["down", "--volumes", "--remove-orphans"]);
  compose(worktree, env, ["up", "--detach", "--wait", "--quiet-pull"]);
  const port = (service: string, containerPort: number): number => {
    const published = compose(worktree, env, ["port", service, String(containerPort)]).trim();
    return Number(published.slice(published.lastIndexOf(":") + 1));
  };
  return { postgres: port("postgres", 5432), valkey: port("valkey", 6379) };
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "0.0.0.0", port }, () => resolve(server));
  });
}

/**
 * One free port per entry: the recorded one when it is still free, else one the OS assigns. All
 * are held open together, so no two entries get the same port.
 */
async function choosePorts(recorded: readonly (number | undefined)[]): Promise<number[]> {
  const servers = await Promise.all(
    recorded.map((port) => listen(port ?? 0).catch(() => listen(0))),
  );
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

function databaseEnvironment(worktree: Worktree, env: DevEnv, ports: DatabasePorts) {
  return {
    ...env,
    SWIZZLE_ARTIFACTS_DIR: path.join(worktree.stateDirectory, "artifacts"),
    SWIZZLE_ENVIRONMENT: ENVIRONMENT,
    DATABASE_URL: `postgresql://swizzle:${env.POSTGRES_PASSWORD}@127.0.0.1:${ports.postgres}/swizzle`,
    NODE_ENV: "development",
    VALKEY_URL: `redis://:${env.VALKEY_PASSWORD}@127.0.0.1:${ports.valkey}`,
  };
}

function serviceEnvironment(record: StackRecord) {
  const tailnet = record.tailnetUrl === undefined ? undefined : new URL(record.tailnetUrl);
  return {
    API_HOST: "127.0.0.1",
    API_PORT: String(record.ports.api),
    // The links in mails open the dashboard where its person reaches it.
    SWIZZLE_DASHBOARD_ORIGIN: tailnet?.origin ?? record.url,
    // Webhook URLs and OAuth callbacks go through the dashboard's /api proxy, so they work where
    // the dashboard does.
    SWIZZLE_PUBLIC_URL: `${tailnet?.origin ?? record.url}/api`,
    SWIZZLE_MAIL_FROM: "Swizzle dev <swizzle@swizzle.test>",
    SWIZZLE_SMTP_URL: record.smtpUrl,
    // Every origin the dashboard is reached at; the api refuses sign-in from any other.
    SWIZZLE_CORS_ORIGINS: [record.url, `http://localhost:${record.ports.web}`, tailnet?.origin]
      .filter((origin) => origin !== undefined)
      .join(","),
    SWIZZLE_DEV_MEMBER_EMAIL: record.login.memberEmail,
    SWIZZLE_DEV_OWNER_EMAIL: record.login.email,
    SWIZZLE_SHUTDOWN_TIMEOUT_MS: "5000",
    // Labels the runner images the worker builds, so it prunes only this stack's images.
    SWIZZLE_STACK: record.project,
    SCHEDULER_HEALTH_PORT: "0",
    VITE_API_PROXY_TARGET: record.apiUrl,
    WEB_ALLOWED_HOSTS: tailnet?.hostname ?? "",
    WEB_PORT: String(record.ports.web),
    WORKER_HEALTH_PORT: "0",
  };
}

/**
 * This host's tailnet name, such as `host.tailnet.ts.net`, when Tailscale runs here. The stack then
 * publishes the dashboard on the tailnet, so a browser on another device of the tailnet signs in.
 */
function tailnetName(): string | undefined {
  try {
    const status = JSON.parse(
      execFileSync("tailscale", ["status", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as { BackendState?: string; Self?: { DNSName?: string } };
    const name = status.Self?.DNSName?.replace(/\.$/u, "");
    return status.BackendState === "Running" && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Publishes the dashboard's loopback port on the same port of the tailnet address over HTTPS, or
 * takes that down. Returns whether `tailscale serve` did it; its output stays out of the log.
 */
function tailscaleServe(port: number, state: "on" | "off"): boolean {
  const args =
    state === "on"
      ? ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]
      : ["serve", `--https=${port}`, "off"];
  try {
    execFileSync("tailscale", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function readRecord(worktree: Worktree): Promise<StackRecord | undefined> {
  const file = path.join(worktree.stateDirectory, "stack.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as StackRecord;
}

async function writeRecord(worktree: Worktree, record: StackRecord): Promise<void> {
  await mkdir(worktree.stateDirectory, { recursive: true });
  const file = path.join(worktree.stateDirectory, "stack.json");
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stale record grants no authority over the process that inherited its PID. */
function ownedOrchestrator(worktree: Worktree, record: StackRecord): number | undefined {
  const identity = processOwnerState(record);
  if (identity.kind === "stopped") return undefined;
  if (
    identity.kind !== "running" ||
    record.root !== worktree.root ||
    identity.root !== worktree.root
  ) {
    throw new Error(
      `Stack ownership mismatch for pid ${record.pid}; refusing to signal or clean up. Record: ${worktree.stateDirectory}/stack.json`,
    );
  }
  return record.pid;
}

/** A worktree match alone cannot authorize a process that reused a recorded group leader PID. */
function survivingGroups(worktree: Worktree, record: StackRecord): ProcessGroup[] {
  return record.groups.filter((group) => {
    const identity = processOwnerState(group);
    return identity.kind === "running" && identity.root === worktree.root;
  });
}

async function status(mode: Mode): Promise<number> {
  const worktree = resolveWorktree(mode);
  const record = await readRecord(worktree);
  const pid = record === undefined ? undefined : ownedOrchestrator(worktree, record);
  process.stdout.write(
    pid === undefined ? "orchestrator: stopped\n" : `orchestrator: running\npid: ${pid}\n`,
  );
  return pid === undefined ? 1 : 0;
}

/**
 * Asks each group's leader, its supervisor, to stop the command, and kills the whole group once
 * the grace period ends. Signals a group only while its leader matches.
 */
async function stopGroups(groups: readonly ProcessGroup[]): Promise<void> {
  const signal = (group: ProcessGroup, name: NodeJS.Signals, pid: number) => {
    if (processOwnerState(group).kind !== "running") return;
    try {
      process.kill(pid, name);
    } catch {}
  };
  // The supervisor passes SIGTERM on once; a group-wide one would reach the command twice.
  for (const group of groups) signal(group, "SIGTERM", group.pid);
  const deadline = Date.now() + stopTimeoutMs;
  while (groups.some((group) => isAlive(-group.pid)) && Date.now() < deadline) await delay(100);
  for (const group of groups) signal(group, "SIGKILL", -group.pid);
}

/** Spawns in a process group of its own, so a stop reaches every descendant. */
function spawnGroup(
  worktree: Worktree,
  argv: readonly [string, ...string[]],
  env: NodeJS.ProcessEnv,
): ChildProcess & ProcessGroup {
  const [command, ...args] = argv;
  const child = spawn(
    process.execPath,
    [path.join(worktree.root, "scripts/dev-stack-supervisor.mts"), command, ...args],
    {
      cwd: worktree.root,
      detached: true,
      env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    },
  );
  if (child.pid === undefined) throw new Error(`Could not start ${command}.`);
  const identity = readProcessIdentity(child.pid);
  if (identity === undefined) throw new Error(`Could not identify process group ${child.pid}.`);
  return Object.assign(child, { pid: child.pid, incarnation: identity.incarnation });
}

function commandExited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("message", (message: CommandExit) => resolve(message.code));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
}

async function start(worktree: Worktree, mode: Mode): Promise<number> {
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined) throw new Error("Cannot identify orchestrator");
  const env = await loadDevEnv();
  const fresh = mode === "fresh";
  const previous = await readRecord(worktree);
  const recipe = previous === undefined ? undefined : ownedOrchestrator(worktree, previous);
  if (recipe !== undefined) {
    throw new Error(`This worktree's stack already runs (pid ${recipe}) at ${previous?.url}`);
  }
  // A recipe killed with SIGKILL leaves its services and its tailnet publication behind; stop
  // them before starting anew.
  if (previous !== undefined) await stopGroups(survivingGroups(worktree, previous));
  if (previous?.tailnetUrl !== undefined) tailscaleServe(previous.ports.web, "off");
  const artifacts = path.join(worktree.stateDirectory, "artifacts");
  const mailbox = path.join(worktree.stateDirectory, "mailbox.txt");
  const forgetData = async () => {
    await rm(artifacts, { force: true, recursive: true });
    await rm(mailbox, { force: true });
  };
  if (fresh) await forgetData();

  const groups: ProcessGroup[] = [];
  let published: number | undefined;
  let stopping = false;
  // The stop path for a signal, a failed step and a service that exits on its own.
  const stop = async (code: number): Promise<never> => {
    if (stopping) return new Promise<never>(() => {});
    stopping = true;
    if (published !== undefined) tailscaleServe(published, "off");
    await stopGroups(groups);
    compose(worktree, env, fresh ? ["down", "--volumes", "--remove-orphans"] : ["stop"]);
    if (fresh) await forgetData();
    process.exit(code);
  };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, () => void stop(0));

  try {
    const [api = 0, web = 0, localWorker = 0] = await choosePorts([
      previous?.ports.api,
      previous?.ports.web,
      previous?.ports.localWorker,
    ]);
    // The stack's own worker, as in the packaged stack: it serves every project and environment.
    // The token stays with the worktree, so a restart keeps the same identity and its revocation.
    await mkdir(worktree.stateDirectory, { recursive: true });
    const { values: local } = await ensureEnvFile(
      path.join(worktree.stateDirectory, "local-worker.env"),
      "# The local worker token of this worktree's dev stack (scripts/dev-stack.mts).\nSWIZZLE_LOCAL_WORKER_TOKEN=\n",
      { SWIZZLE_LOCAL_WORKER_TOKEN: `swz_${secret(32)}` },
    );
    const databasePorts = startDatabases(worktree, env, fresh);
    const url = `http://127.0.0.1:${web}`;
    const sink = await startMailSink({
      onMessage: (mail) => {
        const entry = `To: ${mail.to.join(", ")}\nSubject: ${mail.subject}\n\n${mail.text}\n\n`;
        process.stdout.write(`dev-stack: mail sent\n${entry}`);
        void appendFile(mailbox, entry, { mode: 0o600 });
      },
    });
    const tailnet = tailnetName();
    if (tailnet !== undefined && tailscaleServe(web, "on")) published = web;
    const record: StackRecord = {
      apiUrl: `http://127.0.0.1:${api}`,
      groups,
      login: {
        email: OWNER_EMAIL,
        memberEmail: MEMBER_EMAIL,
        password: env.SWIZZLE_DEV_OWNER_PASSWORD,
      },
      pid: process.pid,
      root: worktree.root,
      incarnation: identity.incarnation,
      mailbox,
      ports: { ...databasePorts, api, localWorker, web },
      project: worktree.project,
      smtpUrl: sink.url,
      ...(published === undefined ? {} : { tailnetUrl: `https://${tailnet}:${web}` }),
      url,
    };
    const workerConcurrency = process.env.WORKER_CONCURRENCY ?? env.WORKER_CONCURRENCY ?? "";
    const childEnv = {
      ...process.env,
      ...databaseEnvironment(worktree, env, databasePorts),
      ...serviceEnvironment(record),
      // The local identity's admission budget matches the worker's execution slots.
      WORKER_CONCURRENCY: workerConcurrency,
      SWIZZLE_LOCAL_WORKER_CAPACITY: workerConcurrency,
      SWIZZLE_LOCAL_WORKER_TOKEN: local.SWIZZLE_LOCAL_WORKER_TOKEN,
      SWIZZLE_LOCAL_WORKER_API_HOST: "127.0.0.1",
      SWIZZLE_LOCAL_WORKER_API_PORT: String(localWorker),
      SWIZZLE_WORKER_API_URL: `http://127.0.0.1:${localWorker}`,
      SWIZZLE_WORKER_TOKEN: local.SWIZZLE_LOCAL_WORKER_TOKEN,
    };
    await writeRecord(worktree, record);

    const seed = spawnGroup(
      worktree,
      ["pnpm", "exec", "tsx", "--conditions=swizzle-source", "scripts/dev-stack-seed.mts"],
      childEnv,
    );
    const seedGroup = { pid: seed.pid, incarnation: seed.incarnation };
    groups.push(seedGroup);
    if ((await commandExited(seed)) !== 0) throw new Error("The seed failed.");
    await stopGroups([seedGroup]);
    groups.splice(groups.indexOf(seedGroup), 1);

    const services = spawnGroup(
      worktree,
      [path.join(worktree.root, "node_modules/.bin/turbo"), "run", "dev", "--ui=stream"],
      childEnv,
    );
    groups.push({ pid: services.pid, incarnation: services.incarnation });
    await writeRecord(worktree, record);
    void commandExited(services).then((code) => {
      if (stopping) return;
      process.stderr.write(`dev-stack: the services exited with code ${code}; stopping.\n`);
      return stop(code === 0 ? 1 : code);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!((await answers(url)) && (await answers(`${record.apiUrl}/ready`)))) {
      if (Date.now() > deadline)
        throw new Error(`The stack did not answer within ${READY_TIMEOUT_MS / 1000} s.`);
      await delay(500);
    }
    process.stdout.write(
      [
        "",
        `swizzle ${fresh ? "dev-fresh" : "dev"} for ${worktree.root}`,
        `  dashboard  ${url}/`,
        ...(record.tailnetUrl === undefined ? [] : [`  tailnet    ${record.tailnetUrl}/`]),
        `  api        ${record.apiUrl}`,
        `  login      ${record.login.email}  ${record.login.password}`,
        `  member     ${record.login.memberEmail}  (same password, no grants)`,
        `  mailbox    ${record.mailbox}`,
        `  record     ${path.join(worktree.stateDirectory, "stack.json")}`,
        fresh
          ? "Ctrl-C or SIGTERM stops it and deletes its data."
          : "Ctrl-C or SIGTERM stops it; the data stays for the next `just dev`.",
        "",
      ].join("\n"),
    );
    return new Promise<number>(() => {});
  } catch (error) {
    process.stderr.write(`dev-stack: ${error instanceof Error ? error.message : String(error)}\n`);
    return stop(1);
  }
}

/**
 * Stops this worktree's stack of each mode, also after its recipe was killed: its processes and
 * containers. The fresh stack's data goes with it; the data of `just dev` stays.
 */
async function down(modes: readonly Mode[]): Promise<number> {
  // Preflight every selected record before touching either stack.
  for (const mode of modes) {
    const worktree = resolveWorktree(mode);
    const record = await readRecord(worktree);
    if (record !== undefined) ownedOrchestrator(worktree, record);
  }
  const env = await loadDevEnv();
  for (const mode of modes) {
    const worktree = resolveWorktree(mode);
    const record = await readRecord(worktree);
    if (record !== undefined) {
      // A live recipe stops its own groups and containers; wait for it, then sweep what is left.
      const recipe = ownedOrchestrator(worktree, record);
      if (recipe !== undefined) process.kill(recipe, "SIGTERM");
      const deadline = Date.now() + 30_000;
      while (
        recipe !== undefined &&
        ownedOrchestrator(worktree, record) !== undefined &&
        Date.now() < deadline
      )
        await delay(100);
      if (recipe !== undefined && ownedOrchestrator(worktree, record) !== undefined)
        throw new Error(`Orchestrator pid ${recipe} survived SIGTERM; refusing cleanup.`);
      await stopGroups(survivingGroups(worktree, record));
      if (record.tailnetUrl !== undefined) tailscaleServe(record.ports.web, "off");
    }
    if (mode === "dev") {
      compose(worktree, env, ["stop"]);
      process.stdout.write(`Stopped ${worktree.project}; its data stays.\n`);
    } else {
      compose(worktree, env, ["down", "--volumes", "--remove-orphans"]);
      await rm(worktree.stateDirectory, { force: true, recursive: true });
      process.stdout.write(`Removed ${worktree.project} and its data.\n`);
    }
  }
  return 0;
}

async function run(worktree: Worktree, argv: readonly [string, ...string[]]): Promise<number> {
  const env = await loadDevEnv();
  const ports = startDatabases(worktree, env, false);
  const child = spawnGroup(worktree, argv, {
    ...process.env,
    ...databaseEnvironment(worktree, env, ports),
  });
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(name, () => void stopGroups([child]));
  }
  try {
    return await commandExited(child);
  } finally {
    await stopGroups([child]);
  }
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "start") return start(resolveWorktree(command.mode), command.mode);
  if (command.kind === "down") return down(command.modes);
  if (command.kind === "status") return status(command.mode);
  return run(resolveWorktree("dev"), command.argv);
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`dev-stack: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

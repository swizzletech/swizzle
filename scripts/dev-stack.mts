import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startMailSink } from "../test/mail-sink.ts";
import { holdPorts } from "./dev-stack-ports.ts";
import type { CommandExit } from "./dev-stack-supervisor.mts";
import { composeTeardownTimeoutMs, stopTimeoutMs } from "./dev-stack-timeout.ts";
import { ensureEnvFile, secret } from "./env-file.ts";
import { processOwnerState, readProcessIdentity } from "./process-identity.ts";

type Mode = "dev" | "fresh";
type ProjectMode = Mode | "verify";

type Command =
  | { readonly kind: "start"; readonly mode: Mode }
  | { readonly kind: "down"; readonly modes: readonly ProjectMode[] }
  | { readonly kind: "status"; readonly mode: Mode }
  | {
      readonly kind: "run";
      readonly mode: "dev" | "verify";
      readonly argv: readonly [string, ...string[]];
    };

interface Worktree {
  readonly root: string;
  readonly stateDirectory: string;
  readonly project: string;
}

type DevEnv = Readonly<Record<(typeof SECRET_NAMES)[number], string>> &
  Readonly<Record<string, string>>;

interface DatabasePorts {
  readonly postgres: number;
  readonly valkey: number;
}

interface Ports extends DatabasePorts {
  readonly api: number;
  readonly localWorker: number;
  readonly web: number;
}

interface ProcessGroup {
  readonly pid: number;
  readonly incarnation: string;
}

interface StackRecord {
  readonly project: string;
  readonly url: string;
  readonly tailnetUrl?: string;
  readonly apiUrl: string;
  readonly ports: Ports;
  readonly mailbox: string;
  readonly smtpUrl: string;
  readonly login: {
    readonly email: string;
    readonly memberEmail: string;
    readonly password: string;
  };
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
const ENVIRONMENT = "staging";
const COMPOSE_FILE = "infra/docker/compose.dev.yml";
const READY_TIMEOUT_MS = 180_000;
const SHUTDOWN_START_TIMEOUT_MS = 15_000;

function parseCommand(argv: readonly string[]): Command {
  const [verb, separator, ...rest] = argv;
  if (verb === "dev" || verb === "fresh") return { kind: "start", mode: verb };
  if (verb === "down" && rest.length === 0 && separator === undefined)
    return { kind: "down", modes: ["dev", "fresh", "verify"] };
  if (verb === "down" && rest.length === 0 && separator === "verify")
    return { kind: "down", modes: ["verify"] };
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
  if ((verb === "run" || verb === "verify") && separator === "--" && program !== undefined) {
    return { kind: "run", mode: verb === "run" ? "dev" : "verify", argv: [program, ...args] };
  }
  throw new Error(
    "usage: node scripts/dev-stack.mts dev | fresh | down [dev|fresh|verify] | status <dev|fresh> | (run|verify) -- <command>",
  );
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const NAMES = {
  dev: "swizzle-dev",
  fresh: "swizzle-dev-fresh",
  verify: "swizzle-dev-verify",
} as const satisfies Record<ProjectMode, string>;

function resolveWorktree(mode: ProjectMode): Worktree {
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

function docker(
  worktree: Worktree,
  env: DevEnv,
  args: readonly string[],
  timeout?: number,
  stdout: "pipe" | "inherit" = "pipe",
): string {
  return (
    execFileSync("docker", args, {
      cwd: worktree.root,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", stdout, "inherit"],
      timeout,
      killSignal: "SIGKILL",
    }) ?? ""
  );
}

function compose(
  worktree: Worktree,
  env: DevEnv,
  args: readonly string[],
  timeout?: number,
): string {
  return docker(
    worktree,
    env,
    ["compose", "-p", worktree.project, "-f", COMPOSE_FILE, ...args],
    timeout,
    timeout === undefined ? "pipe" : "inherit",
  );
}

function assertProjectRemoved(worktree: Worktree, env: DevEnv): void {
  const filter = `label=com.docker.compose.project=${worktree.project}`;
  const queries = {
    containers: ["ps", "--all", "--format", "{{.Names}}"],
    volumes: ["volume", "ls", "--format", "{{.Name}}"],
    networks: ["network", "ls", "--format", "{{.Name}}"],
  };
  const remaining = Object.entries(queries).flatMap(([kind, args]) => {
    const names = docker(worktree, env, [...args, "--filter", filter], composeTeardownTimeoutMs);
    return names.trim() ? [`${kind}: ${names.trim().split("\n").join(", ")}`] : [];
  });
  if (remaining.length > 0) {
    throw new Error(
      `${worktree.project} still has Docker resources (${remaining.join("; ")}). Rerun just dev-down to continue cleanup.`,
    );
  }
}

function startDatabases(worktree: Worktree, env: DevEnv, fresh: boolean): DatabasePorts {
  if (fresh) compose(worktree, env, ["down", "--volumes", "--remove-orphans"]);
  compose(worktree, env, ["up", "--detach", "--wait", "--quiet-pull"]);
  const port = (service: string, containerPort: number): number => {
    const published = compose(worktree, env, ["port", service, String(containerPort)]).trim();
    return Number(published.slice(published.lastIndexOf(":") + 1));
  };
  return { postgres: port("postgres", 5432), valkey: port("valkey", 6379) };
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
    API_PORT: "0",
    SWIZZLE_DASHBOARD_ORIGIN: tailnet?.origin ?? record.url,
    SWIZZLE_API_ORIGIN: `${tailnet?.origin ?? record.url}/api`,
    SWIZZLE_PUBLIC_URL: `${tailnet?.origin ?? record.url}/api`,
    SWIZZLE_MAIL_FROM: "Swizzle dev <swizzle@swizzle.test>",
    SWIZZLE_SMTP_URL: record.smtpUrl,
    SWIZZLE_CORS_ORIGINS: [record.url, `http://localhost:${record.ports.web}`, tailnet?.origin]
      .filter((origin) => origin !== undefined)
      .join(","),
    SWIZZLE_DEV_MEMBER_EMAIL: record.login.memberEmail,
    SWIZZLE_DEV_OWNER_EMAIL: record.login.email,
    SWIZZLE_SHUTDOWN_TIMEOUT_MS: "5000",
    SWIZZLE_STACK: record.project,
    SCHEDULER_HEALTH_PORT: "0",
    VITE_API_PROXY_TARGET: record.apiUrl,
    WEB_ALLOWED_HOSTS: tailnet?.hostname ?? "",
    WORKER_HEALTH_PORT: "0",
  };
}

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

function shutdownMarker(worktree: Worktree, owner: ProcessGroup): string {
  return path.join(worktree.stateDirectory, `stopping-${owner.pid}-${owner.incarnation}`);
}

async function stopOrchestrator(worktree: Worktree, record: StackRecord): Promise<void> {
  const pid = ownedOrchestrator(worktree, record);
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (ownedOrchestrator(worktree, record) === undefined) return;
    throw error;
  }
  const marker = shutdownMarker(worktree, record);
  const startDeadline = performance.now() + stopTimeoutMs + SHUTDOWN_START_TIMEOUT_MS;
  let teardownDeadline: number | undefined;
  while (ownedOrchestrator(worktree, record) !== undefined) {
    const now = performance.now();
    if (teardownDeadline === undefined && existsSync(marker)) {
      teardownDeadline = now + composeTeardownTimeoutMs;
    }
    if (now >= (teardownDeadline ?? startDeadline)) {
      if (ownedOrchestrator(worktree, record) === undefined) return;
      const phase =
        teardownDeadline === undefined
          ? "without starting Compose teardown"
          : "and is stuck in Compose teardown";
      throw new Error(
        `Orchestrator pid ${pid} survived SIGTERM ${phase}. Refusing cleanup. Confirm the PID still belongs to this worktree, then run kill -KILL ${pid} and rerun just dev-down.`,
      );
    }
    await delay(100);
  }
}

async function stopGroups(groups: readonly ProcessGroup[]): Promise<void> {
  const signal = (group: ProcessGroup, name: NodeJS.Signals, pid: number) => {
    if (processOwnerState(group).kind !== "running") return;
    try {
      process.kill(pid, name);
    } catch {}
  };
  for (const group of groups) signal(group, "SIGTERM", group.pid);
  const deadline = Date.now() + stopTimeoutMs;
  while (groups.some((group) => isAlive(-group.pid)) && Date.now() < deadline) await delay(100);
  for (const group of groups) signal(group, "SIGKILL", -group.pid);
}

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
  if (previous !== undefined) await stopGroups(survivingGroups(worktree, previous));
  if (previous?.tailnetUrl !== undefined) tailscaleServe(previous.ports.web, "off");
  if (previous !== undefined) await rm(shutdownMarker(worktree, previous), { force: true });
  const artifacts = path.join(worktree.stateDirectory, "artifacts");
  const mailbox = path.join(worktree.stateDirectory, "mailbox.txt");
  const forgetData = async () => {
    await rm(artifacts, { force: true, recursive: true });
    await rm(mailbox, { force: true });
  };
  await mkdir(worktree.stateDirectory, { recursive: true });
  if (fresh) await forgetData();

  const groups: ProcessGroup[] = [];
  let published: number | undefined;
  let listeners: Awaited<ReturnType<typeof holdPorts>> | undefined;
  const targets = path.join(worktree.stateDirectory, `ports-${identity.incarnation}`);
  let stopping = false;
  const stop = async (code: number): Promise<never> => {
    if (stopping) return new Promise<never>(() => {});
    stopping = true;
    if (published !== undefined) tailscaleServe(published, "off");
    await stopGroups(groups);
    listeners?.close();
    await rm(targets, { recursive: true, force: true });
    await writeFile(
      shutdownMarker(worktree, { pid: process.pid, incarnation: identity.incarnation }),
      "",
    );
    compose(worktree, env, fresh ? ["down", "--volumes", "--remove-orphans"] : ["stop"]);
    if (fresh) await forgetData();
    process.exit(code);
  };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, () => void stop(0));

  try {
    if (previous !== undefined) {
      await rm(path.join(worktree.stateDirectory, `ports-${previous.incarnation}`), {
        recursive: true,
        force: true,
      });
    }
    await mkdir(targets, { mode: 0o700 });
    listeners = await holdPorts(targets, previous?.ports);
    const { api, web, localWorker } = listeners.ports;
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
      WORKER_CONCURRENCY: workerConcurrency,
      SWIZZLE_LOCAL_WORKER_TOKEN: local.SWIZZLE_LOCAL_WORKER_TOKEN,
      SWIZZLE_LOCAL_WORKER_API_HOST: "127.0.0.1",
      SWIZZLE_LOCAL_WORKER_API_PORT: "0",
      SWIZZLE_DEV_API_PORT_FILE: listeners.targets.api,
      SWIZZLE_DEV_LOCAL_WORKER_PORT_FILE: listeners.targets.localWorker,
      WEB_DEV_PORT_FILE: listeners.targets.web,
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

function assertStackOwnershipBeforeShutdown(
  stacks: readonly { worktree: Worktree; record: StackRecord | undefined }[],
): void {
  for (const { worktree, record } of stacks) {
    if (record !== undefined) ownedOrchestrator(worktree, record);
  }
}

function verificationWorktree(worktree: Worktree, owner: ProcessGroup): Worktree {
  const id = `${owner.pid}-${owner.incarnation}`;
  return {
    ...worktree,
    project: `${worktree.project}-${id}`,
    stateDirectory: path.join(`${worktree.stateDirectory}-runs`, id),
  };
}

async function removeProject(worktree: Worktree, env: DevEnv): Promise<void> {
  compose(worktree, env, ["down", "--volumes", "--remove-orphans"], composeTeardownTimeoutMs);
  assertProjectRemoved(worktree, env);
  await rm(worktree.stateDirectory, { force: true, recursive: true });
  process.stdout.write(`Removed ${worktree.project} and its data.\n`);
}

async function removeStaleVerifications(worktree: Worktree, env: DevEnv): Promise<void> {
  const directory = `${worktree.stateDirectory}-runs`;
  const runs = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const [pid, incarnation, extra] = run.name.split("-");
    if (
      pid === undefined ||
      incarnation === undefined ||
      extra !== undefined ||
      !/^[1-9][0-9]*$/u.test(pid) ||
      !/^[a-f0-9]{32}$/u.test(incarnation)
    )
      continue;
    const owner = { pid: Number(pid), incarnation };
    if (processOwnerState(owner).kind === "running") continue;
    await removeProject(verificationWorktree(worktree, owner), env);
  }
}

async function down(modes: readonly ProjectMode[]): Promise<number> {
  const stacks = await Promise.all(
    modes.map(async (mode) => {
      const worktree = resolveWorktree(mode);
      return { mode, worktree, record: await readRecord(worktree) };
    }),
  );
  assertStackOwnershipBeforeShutdown(stacks);
  const env = await loadDevEnv();
  for (const { worktree, record } of stacks) {
    if (record !== undefined) await stopOrchestrator(worktree, record);
  }
  for (const { mode, worktree, record } of stacks) {
    if (record !== undefined) {
      await stopGroups(survivingGroups(worktree, record));
      if (record.tailnetUrl !== undefined) tailscaleServe(record.ports.web, "off");
    }
    if (mode === "dev") {
      compose(worktree, env, ["stop"], composeTeardownTimeoutMs);
      process.stdout.write(`Stopped ${worktree.project}; its data stays.\n`);
    } else {
      await removeProject(worktree, env);
      if (mode === "verify") await removeStaleVerifications(worktree, env);
    }
  }
  return 0;
}

async function runCommand(
  worktree: Worktree,
  argv: readonly [string, ...string[]],
  env: DevEnv,
): Promise<number> {
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

async function run(
  worktree: Worktree,
  command: Extract<Command, { kind: "run" }>,
): Promise<number> {
  const env = await loadDevEnv();
  if (command.mode === "dev") return runCommand(worktree, command.argv, env);
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined) throw new Error("Cannot identify verifier");
  const owned = verificationWorktree(worktree, {
    pid: process.pid,
    incarnation: identity.incarnation,
  });
  await mkdir(owned.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    return await runCommand(owned, command.argv, env);
  } finally {
    await removeProject(owned, env);
  }
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "start") return start(resolveWorktree(command.mode), command.mode);
  if (command.kind === "down") return down(command.modes);
  if (command.kind === "status") return status(command.mode);
  return run(resolveWorktree(command.mode), command);
}

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`dev-stack: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

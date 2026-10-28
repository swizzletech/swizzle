// A throwaway packaged stack: infra/docker/compose.yml as a compose project of its own, from an
// env file with fresh credentials and free ports, with its first account set up and an API token made.
// `just smoke` and `just perf` boot one, `just perf --against` two; each runs beside every other
// stack, and `remove` (also run on SIGINT, SIGTERM or SIGHUP) deletes the project with its volumes
// and the images it built. A SIGKILL skips `remove`, so each throwaway's name carries its owner's
// PID and process incarnation, and the next start sweeps the ones that no longer match.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCli } from "@swizzle/cli";
import { dockerCpus, ensureEnvFile, packagedStackValues, sizeCpuLimits } from "./env-file.ts";
import { processOwnerState, readProcessIdentity } from "./process-identity.ts";

export interface PackagedStack {
  readonly project: string;
  /** The private env file, for checks that restart this same installed stack. */
  readonly envFile: string;
  readonly environment: string;
  /** The dashboard origin; `${dashboard}/api` reaches the api through the same ingress. */
  readonly dashboard: string;
  /** The api hostname. */
  readonly api: string;
  /** The loopback listener a tunnel forwards to; serves only links, webhooks and OAuth callbacks. */
  readonly links: string;
  /** A bearer token minted by the first account. */
  readonly token: string;
  /** The first account's session cookie. */
  readonly session: { readonly name: string; readonly value: string };
  /** Runs `swizzle <args> --json` in process against the stack and returns its stdout. */
  cli(...args: string[]): Promise<string>;
  /** `docker compose <args>` for this project; resolves with its stdout. */
  compose(...args: string[]): Promise<string>;
  remove(): Promise<void>;
}

const STEP_TIMEOUT_MS = 180_000;

let current: ChildProcess | undefined;

/** Runs `argv`; resolves with its stdout, which goes to stderr as progress unless `quiet`. */
function run(argv: readonly [string, ...string[]], quiet: boolean): Promise<string> {
  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", quiet ? "pipe" : process.stderr, "inherit"],
    });
    current = child;
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      current = undefined;
      if (code === 0) resolve(stdout);
      else reject(new Error(`${argv.join(" ")} exited with ${signal ?? code}.\n${stdout}`));
    });
  });
}

/**
 * The name prefix of a throwaway this process owns: a compose project, its temp directory, and the
 * checkout `just perf` unpacks. Sweeping verifies the recorded PID and incarnation.
 */
export function throwawayPrefix(name: "smoke" | "perf"): string {
  const identity = readProcessIdentity(process.pid);
  if (identity === undefined) throw new Error("Cannot identify the packaged stack owner");
  return `swizzle-${name}-${process.pid}-${identity.incarnation}-`;
}

const THROWAWAY = /^(swizzle-(?:smoke|perf)-(\d+)-([0-9a-f]{32})-[0-9a-f]{8})(?:-|$)/u;

/**
 * Deletes a throwaway project: its services, volumes, networks and built images, and also the run
 * containers and runner images the worker made outside compose. The worker labels its images
 * swizzle.stack=<project>, and they and their containers inherit the compose project label from
 * runner-base. Removing labelled resources also covers a partial start whose Compose config is gone.
 */
async function removeProject(project: string): Promise<void> {
  const label = `label=com.docker.compose.project=${project}`;
  const removeContainers = async () => {
    const containers = await run(["docker", "ps", "--all", "--quiet", "--filter", label], true);
    const ids = containers.split("\n").filter((id) => id !== "");
    if (ids.length > 0) await run(["docker", "rm", "--force", "--volumes", ...ids], true);
  };
  // Run containers carry --rm, so the daemon may already be removing one, and `docker rm` then
  // fails on it; a second pass after that removal finds only what is really left.
  await removeContainers().catch(async () => {
    await delay(2_000);
    await removeContainers();
  });
  // Cleanup cannot depend on the Compose file or profiles that created a partial project.
  for (const resource of ["network", "volume"] as const) {
    const listed = await run(["docker", resource, "ls", "--quiet", "--filter", label], true);
    const ids = listed.split("\n").filter((id) => id !== "");
    if (ids.length > 0) await run(["docker", resource, "rm", ...ids], true);
  }
  // Image prune holds a daemon-wide lock. Delete owned IDs so parallel stacks can clean up.
  const images = new Set<string>();
  for (const filter of [label, `label=swizzle.stack=${project}`]) {
    const listed = await run(
      ["docker", "image", "ls", "--all", "--quiet", "--filter", filter],
      true,
    );
    for (const id of listed.split("\n").filter((id) => id !== "")) images.add(id);
  }
  if (images.size > 0) await run(["docker", "image", "rm", "--force", ...images], true);
}

/**
 * Removes the throwaway projects and temp directories whose owner process is gone, as a SIGKILL
 * leaves them. A project shows up by its label on any container, volume, network or image, so one
 * killed before its first container still goes. A project whose owner identity still matches is left alone.
 */
async function sweepAbandonedThrowaways(log: (message: string) => void): Promise<void> {
  const label = '{{.Label "com.docker.compose.project"}}';
  const listed = await Promise.all(
    [
      ["docker", "ps", "--all", "--format", label],
      ["docker", "volume", "ls", "--format", label],
      ["docker", "network", "ls", "--format", label],
    ].map((argv) => run(argv as [string, ...string[]], true)),
  );
  // `image ls` cannot print a label, so the images' labels come from `image inspect`.
  const images = await run(
    ["docker", "image", "ls", "--all", "--quiet", "--filter", "label=com.docker.compose.project"],
    true,
  );
  const imageIds = [...new Set(images.split("\n").filter((id) => id !== ""))];
  if (imageIds.length > 0) {
    listed.push(
      await run(
        [
          "docker",
          "image",
          "inspect",
          "--format",
          '{{index .Config.Labels "com.docker.compose.project"}}',
          ...imageIds,
        ],
        true,
      ),
    );
  }
  const abandoned = (name: string) => {
    const match = THROWAWAY.exec(name);
    if (match === null) return undefined;
    const [, project, pid, incarnation] = match;
    if (pid === undefined || incarnation === undefined) return undefined;
    return processOwnerState({ pid: Number(pid), incarnation }).kind === "running"
      ? undefined
      : project;
  };
  const projects = new Set(
    listed
      .flatMap((output) => output.split("\n").map(abandoned))
      .filter((name) => name !== undefined),
  );
  for (const project of projects) {
    log(`removing ${project}, whose owner is gone`);
    await removeProject(project).catch((error: unknown) =>
      process.stderr.write(`sweep: ${String(error)}\n`),
    );
  }
  for (const entry of await readdir(os.tmpdir())) {
    if (abandoned(entry) !== undefined) {
      await rm(path.join(os.tmpdir(), entry), { force: true, recursive: true });
    }
  }
}

/** Three ports nobody listens on, held open together so they differ. */
async function freePorts(): Promise<[number, number, number]> {
  const listen = () =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen({ host: "0.0.0.0", port: 0 }, () => resolve(server));
    });
  const servers = [await listen(), await listen(), await listen()];
  const [http = 0, https = 0, links = 0] = servers.map(
    (server) => (server.address() as { port: number }).port,
  );
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return [http, https, links];
}

/** The body of a 2xx answer to a GET, or undefined while the stack does not give one. */
export async function get(url: string, token?: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

/** POSTs JSON as the dashboard does and returns the answer; anything but a 2xx throws. */
async function post(
  url: string,
  origin: string,
  body: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`POST ${url} answered ${response.status}: ${await response.text()}`);
  }
  return response;
}

/** Cleanups for SIGINT, SIGTERM and SIGHUP, run newest first before the process exits. */
const cleanups: (() => Promise<void>)[] = [];

/**
 * Runs `cleanup` when the process is signalled. Cleanups run newest first, so a stack goes before
 * the checkout it was built from.
 */
export function cleanUpOnSignal(cleanup: () => Promise<void>): void {
  if (cleanups.length === 0) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        void (async () => {
          for (const task of cleanups.toReversed()) await task().catch(() => undefined);
          process.exit(1);
        })();
      });
    }
  }
  cleanups.push(cleanup);
}

/** Polls `probe` until it returns a value, and fails after STEP_TIMEOUT_MS. */
export async function until<T>(
  description: string,
  probe: () => Promise<T | undefined>,
  log: (message: string) => void,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      log(description);
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${STEP_TIMEOUT_MS / 1000} s waiting until ${description}.`);
    }
    await delay(intervalMs);
  }
}

/**
 * Runs `swizzle <args> --json` against the stack whose CLI profile lives in `configHome` and
 * returns its stdout; a non-zero exit throws. The CLI reads its profile from SWIZZLE_CONFIG_HOME
 * and the token from the variable the profile names, so each call points both at its own stack.
 */
async function cli(configHome: string, token: string, args: readonly string[]): Promise<string> {
  process.env.SWIZZLE_CONFIG_HOME = configHome;
  process.env.SWIZZLE_STACK_TOKEN = token;
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--json"], {
    stderr: (message) => {
      stderr += message;
    },
    stdout: (message) => {
      stdout += message;
    },
  });
  if (code !== 0)
    throw new Error(`swizzle ${args.join(" ")} exited with ${code}:\n${stdout}${stderr}`);
  return stdout;
}

/**
 * Boots the stack from the checkout at `root` and waits until api, scheduler and worker are ready.
 * A failure prints the project's logs and removes it before it throws.
 */
export async function startPackagedStack(
  name: "smoke" | "perf",
  log: (message: string) => void,
  root = ".",
  environment: Readonly<Record<string, string>> = {},
): Promise<PackagedStack> {
  // A sweep that fails, as when two starts race for the same project, reports and lets the stack boot.
  await sweepAbandonedThrowaways(log).catch((error: unknown) =>
    process.stderr.write(`sweep: ${String(error)}\n`),
  );
  const project = `${throwawayPrefix(name)}${randomBytes(4).toString("hex")}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), `${project}-`));
  const envFile = path.join(directory, ".env");
  const [httpPort, httpsPort, linkPort] = await freePorts();
  const dashboard = `http://localhost:${httpPort}`;
  const api = `http://api.localhost:${httpPort}`;

  const compose = (...args: string[]) =>
    run(
      [
        "docker",
        "compose",
        "--project-name",
        project,
        "--env-file",
        envFile,
        "--profile",
        "stack",
        "-f",
        path.join(root, "infra/docker/compose.yml"),
        ...args,
      ],
      args[0] !== "up" && args[0] !== "down",
    );

  let removal: Promise<void> | undefined;
  const remove = (): Promise<void> => {
    removal ??= (async () => {
      current?.kill("SIGTERM");
      log(`removing ${project} with its volumes`);
      await removeProject(project).catch((error: unknown) =>
        process.stderr.write(`${name}: ${String(error)}\n`),
      );
      await rm(directory, { force: true, recursive: true });
    })();
    return removal;
  };
  cleanUpOnSignal(remove);

  try {
    const values = packagedStackValues(project);
    const initialized = await ensureEnvFile(
      envFile,
      await readFile(path.join(root, ".env.example"), "utf8"),
      {
        ...values,
        ...environment,
        SWIZZLE_API_ORIGIN: api,
        SWIZZLE_DASHBOARD_ORIGIN: dashboard,
        SWIZZLE_HTTP_PORT: String(httpPort),
        SWIZZLE_HTTPS_PORT: String(httpsPort),
        SWIZZLE_LINK_PORT: String(linkPort),
      },
    );
    await sizeCpuLimits(envFile, dockerCpus());
    const environmentName = initialized.values.SWIZZLE_ENVIRONMENT;
    if (!environmentName) throw new Error("Packaged stack has no default environment.");
    log(`starting ${project} at ${dashboard}`);
    await compose("up", "--build", "--detach", "--wait", "--quiet-pull");

    await until(
      "the dashboard ingress serves the dashboard",
      async () =>
        (await get(`${dashboard}/`))?.toLowerCase().includes("<!doctype html") ? true : undefined,
      log,
    );
    for (const [route, url] of [
      ["the same-origin api proxy", `${dashboard}/api/health`],
      ["the api hostname", `${api}/health`],
    ] as const) {
      await until(
        `${route} answers`,
        async () => ((await get(url))?.includes('"status":"ok"') ? true : undefined),
        log,
      );
    }

    const setup = await post(
      `${dashboard}/api/auth/sign-up/email`,
      dashboard,
      {
        email: `${name}@swizzle.test`,
        name: `Self-hosted ${name}`,
        password: values.SWIZZLE_SETUP_TOKEN,
      },
      undefined,
      { "x-swizzle-setup-token": values.SWIZZLE_SETUP_TOKEN },
    );
    const cookie =
      setup.headers
        .getSetCookie()
        .map((header) => header.split(";")[0] ?? "")
        .find((pair) => pair.split("=")[0]?.endsWith("session_token")) ?? "";
    const separator = cookie.indexOf("=");
    const session = { name: cookie.slice(0, separator), value: cookie.slice(separator + 1) };
    const created = await post(
      `${dashboard}/api/auth/tokens`,
      dashboard,
      { name: `${name}-token` },
      cookie,
    );
    const { token } = (await created.json()) as { token: string };
    log("claimed the instance and created an API token");
    // Outside loopback the api answers /ready only to an authenticated caller.
    await until(
      "the api reports ready",
      async () =>
        (await get(`${dashboard}/api/ready`, token))?.includes('"status":"ready"')
          ? true
          : undefined,
      log,
    );
    await until(
      "the scheduler sends heartbeats and a worker is online",
      async () => {
        const body = await get(
          `${dashboard}/api/ops/summary?environment=${environmentName}`,
          token,
        );
        if (body === undefined) return undefined;
        // The scheduler writes a service heartbeat; a worker's liveness lives on its workers row.
        const summary = JSON.parse(body) as {
          services: { summary: { service: string; alive: number }[] };
          onlineWorkers: number;
        };
        const scheduler = summary.services.summary.some(
          (entry) => entry.service === "scheduler" && entry.alive >= 1,
        );
        return scheduler && summary.onlineWorkers >= 1 ? true : undefined;
      },
      log,
    );

    const configHome = path.join(directory, "cli");
    const stackCli = (...args: string[]) => cli(configHome, token, args);
    await stackCli(
      "profile",
      "add",
      name,
      "--url",
      `${dashboard}/api`,
      "--env",
      environmentName,
      "--token-env",
      "SWIZZLE_STACK_TOKEN",
      "--default",
    );
    return {
      api,
      cli: stackCli,
      compose,
      dashboard,
      environment: environmentName,
      envFile,
      links: `http://127.0.0.1:${linkPort}`,
      project,
      remove,
      session,
      token,
    };
  } catch (error) {
    process.stdout.write(await compose("logs", "--no-color", "--tail=200").catch(() => ""));
    await remove();
    throw error;
  }
}

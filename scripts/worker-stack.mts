// Start one worker-only stack on the engine selected by the Docker CLI. No host executor.
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

const credentialFile = process.argv[2];
if (!credentialFile || process.argv.length > 4) {
  console.error("Usage: just worker <credential-file> [compose-override]");
  process.exit(2);
}
const relative = path.relative(await realpath("."), await realpath(credentialFile));
if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  throw new Error(
    "Keep the worker credential outside this repository so the Docker build cannot copy it.",
  );
const credential = await readFile(credentialFile, "utf8");
const settings = parseEnv(credential);
if (
  !settings.SWIZZLE_WORKER_API_URL ||
  !settings.SWIZZLE_WORKER_TOKEN ||
  !settings.SWIZZLE_WORKER_ID
)
  throw new Error("Use the credential file written by swizzle worker enroll.");
const environment: NodeJS.ProcessEnv & { COMPOSE_PROJECT_NAME: string } = {
  ...process.env,
  COMPOSE_PROJECT_NAME:
    process.env.COMPOSE_PROJECT_NAME ?? settings.COMPOSE_PROJECT_NAME ?? "swizzle-worker",
};
function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, {
    env: environment,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
    ...(input === undefined ? {} : { input }),
    timeout: 30 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Docker ${args[0]} exited with ${result.status}. See the Docker error above.`);
  return result.stdout.trim();
}
const context = docker(["context", "show"]);
const endpoint = process.env.DOCKER_CONTEXT
  ? docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"])
  : (process.env.DOCKER_HOST ??
    docker(["context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"]));
if (!endpoint.startsWith("unix://"))
  throw new Error(
    "The worker stack requires a local Unix Docker context. Select Docker Desktop, OrbStack, Colima or a local Linux engine.",
  );
const engine = docker(["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
const platforms: Readonly<Record<string, string>> = {
  "linux/x86_64": "linux/amd64",
  "linux/amd64": "linux/amd64",
  "linux/aarch64": "linux/arm64",
  "linux/arm64": "linux/arm64",
};
const platform = platforms[engine];
if (!platform)
  throw new Error(
    `Unsupported Docker engine ${engine}. A Linux amd64 or arm64 engine is required.`,
  );
if (process.env.DOCKER_DEFAULT_PLATFORM && process.env.DOCKER_DEFAULT_PLATFORM !== platform)
  throw new Error(
    `DOCKER_DEFAULT_PLATFORM must match this engine (${platform}). Build native runner images.`,
  );
environment.DOCKER_DEFAULT_PLATFORM = platform;
console.log(
  `Worker engine: ${context}, ${platform}. Broker socket: /var/run/docker.sock inside the engine.`,
);
const compose = [
  "compose",
  "--env-file",
  path.resolve(credentialFile),
  "-f",
  "infra/docker/compose.worker.yml",
];
if (process.argv[3]) compose.push("-f", path.resolve(process.argv[3]));
console.log(docker([...compose, "build"]));
// The named volume survives restarts. Never replace a renewed credential with its enrollment copy.
const initialize = `
import { link, open, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
let text = ''; for await (const part of process.stdin) text += part;
const target = '/data/worker/worker.env';
const draft = '/data/worker/.bootstrap-' + randomUUID() + '.draft';
try {
  const file = await open(draft, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  try { await link(draft, target); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (parseEnv(await readFile(target, 'utf8')).SWIZZLE_WORKER_ID !== parseEnv(text).SWIZZLE_WORKER_ID)
      throw new Error('This Compose project holds another worker. Choose another COMPOSE_PROJECT_NAME.');
  }
} finally { await rm(draft, { force: true }); }
`;
console.log(
  docker(
    [
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "node",
      "worker",
      "--input-type=module",
      "-e",
      initialize,
    ],
    credential,
  ),
);
console.log(docker([...compose, "up", "-d", "--wait", "--wait-timeout", "120"]));
console.log(
  `Worker stack ${environment.COMPOSE_PROJECT_NAME} is healthy. Credential: worker-credentials volume. Stop it with docker compose -p ${environment.COMPOSE_PROJECT_NAME} -f infra/docker/compose.worker.yml --env-file ${credentialFile} down.`,
);

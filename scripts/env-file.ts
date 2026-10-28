// Writes the KEY=value env files the scripts generate with fresh secrets: the packaged stack's
// .env (scripts/init-env.ts), the throwaway env of `just smoke` and `just perf`
// (scripts/packaged-stack.mts) and the per-user dev.env (scripts/dev-stack.mts). Plain Node runs
// it, so it uses erasable TypeScript only.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";

/** A URL-safe secret of `bytes` random bytes. */
export function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * What `.env.example` leaves blank: fresh credentials and the compose project that holds the
 * stack's volumes. The project carries the credentials' name, so volumes a former env file
 * initialized never meet the passwords of another.
 */
export function packagedStackValues(project: string) {
  return {
    SWIZZLE_ENCRYPTION_KEY: secret(32),
    SWIZZLE_SETUP_TOKEN: secret(48),
    SWIZZLE_LOCAL_LLM_CONTROL_TOKEN: secret(32),
    SWIZZLE_LOCAL_WORKER_TOKEN: `swz_${secret(32)}`,
    COMPOSE_PROJECT_NAME: project,
    POSTGRES_PASSWORD: secret(32),
    VALKEY_PASSWORD: secret(32),
  };
}

/** What `ensureEnvFile` left behind. */
export interface EnvFileState {
  /** Whether this call created the file. */
  readonly created: boolean;
  /** The file's `KEY=value` lines after the call, the ones every concurrent caller sees. */
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Creates `file` from `template` once, or validates its required `values` keys without changing it.
 * Each caller writes a private draft, then links it to the final name without replacing an
 * existing file. Concurrent callers read the same complete file and keep its credentials.
 */
export async function ensureEnvFile(
  file: string,
  template: string,
  values: Readonly<Record<string, string>>,
): Promise<EnvFileState> {
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) return { created: false, values: validate(file, existing, values) };

  const content = fromTemplate(file, template, values);
  const draft = `${file}.${randomUUID()}.draft`;
  try {
    await writeFile(draft, content, { flag: "wx", mode: 0o600 });
    const created = await link(draft, file)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        return false;
      });
    return {
      created,
      values: validate(file, created ? content : await readFile(file, "utf8"), values),
    };
  } finally {
    await rm(draft, { force: true });
  }
}

/** Retires the persistent image tag; the packaged API now reports its own code version. */
export function removeImageTag(file: string): Promise<boolean> {
  return updateEnvFile(file, { SWIZZLE_IMAGE_TAG: undefined });
}

/** The CPU count of the Docker engine the Docker CLI selects, which bounds every `cpus` limit. */
export function dockerCpus(): number {
  const output = execFileSync("docker", ["info", "--format", "{{.NCPU}}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const cpus = Number(output.trim());
  if (!Number.isSafeInteger(cpus) || cpus < 1) {
    throw new Error(`docker info reported ${JSON.stringify(output.trim())} CPUs.`);
  }
  return cpus;
}

/**
 * Sizes a CPU limit to a Docker engine with `hostCpus` CPUs, which refuses a container that asks
 * for more. An empty value becomes `preferred`, or the host's count when that is smaller. An
 * explicit value stays, and one above the host throws an error that names it.
 */
export function cpuLimit(
  name: string,
  value: string | undefined,
  hostCpus: number,
  preferred: number,
): string {
  if (!value) return String(Math.min(preferred, hostCpus));
  if (Number(value) > hostCpus) {
    throw new Error(
      `${name}=${value} exceeds the ${hostCpus} CPU${hostCpus === 1 ? "" : "s"} of the Docker host. ` +
        `Set it to ${hostCpus} or less, or leave it empty to size it to the host.`,
    );
  }
  return value;
}

/**
 * Writes the packaged stack's CPU limits into `file`, sized by `cpuLimit` to the Docker host, and
 * returns the keys it changed. A file without a SWIZZLE_WORKER_CPUS line predates sizing, so its
 * SWIZZLE_MAX_RUN_CPUS=2 is the 1.0.2 template's, never started a smaller host's stack, and is
 * sized like an empty one. Compose prefers an exported limit to the file's, so that must fit too.
 */
export async function sizeCpuLimits(file: string, hostCpus: number): Promise<string[]> {
  const values = parseEnv(await readFile(file, "utf8"));
  const predatesSizing = values.SWIZZLE_WORKER_CPUS === undefined;
  const maxRun = values.SWIZZLE_MAX_RUN_CPUS;
  for (const name of ["SWIZZLE_WORKER_CPUS", "SWIZZLE_MAX_RUN_CPUS"]) {
    try {
      cpuLimit(name, process.env[name], hostCpus, 2);
    } catch (error) {
      throw new Error(
        `${(error as Error).message} Compose reads it from the shell before ${file}.`,
      );
    }
  }
  const limits = {
    SWIZZLE_WORKER_CPUS: cpuLimit("SWIZZLE_WORKER_CPUS", values.SWIZZLE_WORKER_CPUS, hostCpus, 2),
    SWIZZLE_MAX_RUN_CPUS: cpuLimit(
      "SWIZZLE_MAX_RUN_CPUS",
      predatesSizing && maxRun === "2" ? undefined : maxRun,
      hostCpus,
      2,
    ),
  };
  const changed = Object.entries(limits).filter(([name, value]) => values[name] !== value);
  await updateEnvFile(file, Object.fromEntries(changed));
  return changed.map(([name]) => name);
}

/**
 * Sets each key's lines in `file` to its value, appending a key the file lacks, and removes the
 * lines of a key whose value is undefined. Returns whether the file changed.
 */
async function updateEnvFile(
  file: string,
  changes: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const existing = await readFile(file, "utf8");
  let content = existing;
  for (const [name, value] of Object.entries(changes)) {
    const line = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${name}[\\t ]*=.*(?:\\r?\\n|$)`, "gmu");
    if (value === undefined) content = content.replace(line, "");
    else if (content.search(line) >= 0) content = content.replace(line, `${name}=${value}\n`);
    else content = `${content.replace(/(?<=[^\n])$/u, "\n")}${name}=${value}\n`;
  }
  if (content === existing) return false;
  const draft = `${file}.${randomUUID()}.draft`;
  try {
    await writeFile(draft, content, { flag: "wx", mode: 0o600 });
    await rename(draft, file);
  } finally {
    await rm(draft, { force: true });
  }
  return true;
}

function fromTemplate(file: string, template: string, values: Readonly<Record<string, string>>) {
  let content = template;
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^${name}=.*$`, "mu");
    if (!line.test(content)) throw new Error(`The template for ${file} has no ${name}= line.`);
    content = content.replace(line, `${name}=${value}`);
  }
  return content;
}

// The only local worker token provisionLocalWorker (packages/db/src/local-worker.ts) accepts,
// the one packagedStackValues generates. Checkouts older than 1.0.0 wrote another format.
const LOCAL_WORKER_TOKEN = /^swz_[A-Za-z0-9_-]{43}$/u;

function validate(file: string, content: string, required: Readonly<Record<string, string>>) {
  const values = parseEnv(content);
  const missing = Object.keys(required).filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(
      `${file} is missing required values for ${missing.join(", ")}. ` +
        `Restore them, or delete ${file} and rerun this command to generate fresh credentials.`,
    );
  }
  const token = values.SWIZZLE_LOCAL_WORKER_TOKEN;
  if ("SWIZZLE_LOCAL_WORKER_TOKEN" in required && !LOCAL_WORKER_TOKEN.test(token ?? "")) {
    throw new Error(
      `${file} has a SWIZZLE_LOCAL_WORKER_TOKEN in an earlier format, which the API refuses. ` +
        "Replace its value with the output of " +
        `node -e 'console.log("swz_" + require("node:crypto").randomBytes(32).toString("base64url"))', ` +
        `or delete ${file} and rerun this command to generate fresh credentials.`,
    );
  }
  return values;
}

/** Reads `KEY=value` lines as Compose does: quotes enclose a value, and ` #` starts a comment. */
function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] === undefined) continue;
    const raw = match[2] ?? "";
    const quoted = /^\s*(["'])(.*?)\1/u.exec(raw);
    values[match[1]] = quoted ? (quoted[2] ?? "") : raw.replace(/\s+#.*$/u, "").trim();
  }
  return values;
}

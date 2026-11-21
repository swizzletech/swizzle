import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";

export function secret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

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

export interface EnvFileState {
  readonly created: boolean;
  readonly values: Readonly<Record<string, string>>;
}

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

export function removeImageTag(file: string): Promise<boolean> {
  return updateEnvFile(file, { SWIZZLE_IMAGE_TAG: undefined });
}

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

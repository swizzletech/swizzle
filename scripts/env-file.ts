// Writes the KEY=value env files the scripts generate with fresh secrets: the packaged stack's
// .env (scripts/init-env.ts), the throwaway env of `just smoke` and `just perf`
// (scripts/packaged-stack.mts) and the per-user dev.env (scripts/dev-stack.mts). Plain Node runs
// it, so it uses erasable TypeScript only.

import { randomBytes, randomUUID } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";

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

function fromTemplate(file: string, template: string, values: Readonly<Record<string, string>>) {
  let content = template;
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^${name}=.*$`, "mu");
    if (!line.test(content)) throw new Error(`The template for ${file} has no ${name}= line.`);
    content = content.replace(line, `${name}=${value}`);
  }
  return content;
}

function validate(file: string, content: string, required: Readonly<Record<string, string>>) {
  const values = parseEnv(content);
  const missing = Object.keys(required).filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(
      `${file} is missing required values for ${missing.join(", ")}. ` +
        `Restore them, or delete ${file} and rerun this command to generate fresh credentials.`,
    );
  }
  return values;
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = (match[2] ?? "").trim();
  }
  return values;
}

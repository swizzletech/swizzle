import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentError, EXIT_CODES } from "./output.js";

export interface StoredProfile {
  readonly name: string;
  readonly url: string;
  readonly token?: string;
  readonly tokenEnv?: string;
  readonly environment?: string;
  /** The project, by slug or id, that commands with a `--project` option default to. */
  readonly project?: string;
}

export interface ProfileConfig {
  readonly defaultProfile?: string;
  readonly profiles: Record<string, StoredProfile>;
}

/**
 * A token the CLI may send as `Authorization: Bearer <token>`. Only this module makes one, so
 * every header the API client builds carries a checked value: fetch refuses a header with a line
 * break and quotes the whole value in its error, which would print the token.
 */
export type BearerToken = string & { readonly __brand: "BearerToken" };

// The b64token grammar of RFC 6750, which every Swizzle token (`swz_` and base64url) satisfies.
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/u;
const BEARER_TOKEN_RULE = "a bearer token holds only letters, digits and - . _ ~ + /";

function isBearerToken(value: string): value is BearerToken {
  return BEARER_TOKEN.test(value);
}

/** Refuses a `--token` value before it is stored, without echoing it. */
export function assertBearerTokenFlag(value: string): void {
  if (isBearerToken(value)) return;
  throw new AgentError({
    code: "PROFILE_TOKEN_MALFORMED",
    exitCode: EXIT_CODES.usage,
    hint: "Pass the token alone, without a line break or space, or read it at runtime with --token-env <var>.",
    message: `--token is malformed: ${BEARER_TOKEN_RULE}.`,
  });
}

export interface ResolvedProfile {
  readonly name: string;
  readonly source: "flag" | "env" | "default";
  readonly url: string;
  readonly token: BearerToken | null;
  // The environment declared on the profile (if any). Consumers feed this into
  // `resolveEnvironment` — it is not the final environment, only the profile's
  // contribution to the precedence chain.
  readonly environment: string | null;
  readonly project: string | null;
}

export interface ResolveEnvironmentInput {
  // Explicit `-e/--environment` value, or `undefined` when the flag was not
  // passed (i.e. commander is sitting on its default).
  readonly flag?: string;
  readonly profileEnvironment?: string | null;
  readonly profileName?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type ResolvedEnvironment =
  | { readonly environment: string; readonly source: "flag" | "profile" | "env" }
  // A named profile pins nothing: the caller must surface an error rather than proceed.
  | { readonly environment: null; readonly source: "unpinned"; readonly profileName?: string };

/**
 * Single source of truth for which environment a CLI command targets.
 *
 * Precedence: explicit `-e/--environment` flag > the resolved profile's
 * `environment` > the `SWIZZLE_ENVIRONMENT` env var. The profile outranks the
 * env var on purpose: a profile is a deliberate statement about a specific
 * instance, whereas the env var is ambient shell state that quietly leaks
 * across targets.
 *
 * With no environment pinned, callers report an error instead of guessing a namespace.
 */
export function resolveEnvironment(input: ResolveEnvironmentInput = {}): ResolvedEnvironment {
  const env = input.env ?? process.env;

  const flag = input.flag?.trim();
  if (flag !== undefined && flag.length > 0) {
    return { environment: flag, source: "flag" };
  }

  const profileEnvironment = input.profileEnvironment?.trim();
  if (profileEnvironment !== undefined && profileEnvironment.length > 0) {
    return { environment: profileEnvironment, source: "profile" };
  }

  const envVar = (env.SWIZZLE_ENVIRONMENT ?? "").trim();
  if (envVar.length > 0) {
    return { environment: envVar, source: "env" };
  }

  return {
    environment: null,
    source: "unpinned",
    ...(input.profileName !== undefined ? { profileName: input.profileName } : {}),
  };
}

export interface ResolveProfileInput {
  readonly profile?: string;
  readonly apiUrl?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: ProfileConfig;
}

function getProfileConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SWIZZLE_CONFIG_HOME;
  const root = override && override.length > 0 ? override : path.join(os.homedir(), ".swizzle");
  return path.join(root, "config.toml");
}

export async function loadProfileConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProfileConfig> {
  const configPath = getProfileConfigPath(env);
  try {
    const raw = await readFile(configPath, "utf8");
    return parseProfileToml(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { profiles: {} };
    }
    throw new AgentError({
      code: "PROFILE_CONFIG_READ_FAILED",
      message: `Could not read profile config at ${configPath}: ${(error as Error).message}`,
      hint: "Delete the file to reset, or fix the TOML syntax.",
      retryable: false,
    });
  }
}

export async function saveProfileConfig(
  config: ProfileConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configPath = getProfileConfigPath(env);
  const configDirectory = path.dirname(configPath);
  await mkdir(configDirectory, { mode: 0o700, recursive: true });
  await chmod(configDirectory, 0o700);
  await writeFile(configPath, serializeProfileToml(config), { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
  return configPath;
}

export function resolveProfile(input: ResolveProfileInput): ResolvedProfile {
  const env = input.env ?? process.env;
  const config = input.config ?? { profiles: {} };

  if (input.profile !== undefined && input.profile.length > 0) {
    const profile = config.profiles[input.profile];
    if (profile === undefined) {
      throw new AgentError({
        code: "PROFILE_NOT_FOUND",
        message: `Profile "${input.profile}" is not configured.`,
        fixCommand: `swizzle profile add ${input.profile} --url <url> --token-env <VAR>`,
        retryable: false,
        details: { available: Object.keys(config.profiles) },
      });
    }
    return finalize(profile, "flag", env, input.apiUrl);
  }

  const envProfileName = (env.SWIZZLE_PROFILE ?? "").trim();
  if (envProfileName.length > 0) {
    const profile = config.profiles[envProfileName];
    if (profile === undefined) {
      throw new AgentError({
        code: "PROFILE_NOT_FOUND",
        message: `SWIZZLE_PROFILE points to "${envProfileName}" but it is not configured.`,
        fixCommand: `swizzle profile add ${envProfileName} --url <url> --token-env <VAR>`,
        retryable: false,
      });
    }
    return finalize(profile, "env", env, input.apiUrl);
  }

  const defaultName = config.defaultProfile;
  if (defaultName !== undefined && config.profiles[defaultName] !== undefined) {
    const profile = config.profiles[defaultName];
    if (profile !== undefined) {
      return finalize(profile, "default", env, input.apiUrl);
    }
  }

  throw new AgentError({
    code: "SIGN_IN_REQUIRED",
    message: "No CLI profile is configured. Sign in to use the API.",
    exitCode: EXIT_CODES.auth,
    fixCommand:
      "swizzle profile add <name> --url <api-url> --token-env SWIZZLE_TOKEN --env <environment> --default",
    hint: "Sign in to the dashboard, create an API token in Settings > Agent access, and set SWIZZLE_TOKEN to that token.",
  });
}

function finalize(
  profile: StoredProfile,
  source: ResolvedProfile["source"],
  env: NodeJS.ProcessEnv,
  overrideUrl: string | undefined,
): ResolvedProfile {
  return {
    name: profile.name,
    source,
    url: overrideUrl ?? profile.url,
    token: resolveToken(profile, env),
    environment: profile.environment ?? null,
    project: profile.project ?? null,
  };
}

/** The profile's token, refused by name, never by value, when it cannot be sent as a header. */
function resolveToken(profile: StoredProfile, env: NodeJS.ProcessEnv): BearerToken | null {
  const token = storedToken(profile, env);
  if (token === null) return null;
  if (isBearerToken(token.value)) return token.value;
  const hint = `Set ${token.variable ?? "SWIZZLE_TOKEN"} to the token alone, without a line break or space, as Settings > Agent access shows it.`;
  throw new AgentError(
    token.variable === null
      ? {
          code: "PROFILE_TOKEN_MALFORMED",
          exitCode: EXIT_CODES.auth,
          fixCommand: `swizzle profile add ${profile.name} --url ${profile.url} --token-env SWIZZLE_TOKEN`,
          hint,
          message: `The inline token of profile "${profile.name}" is malformed: ${BEARER_TOKEN_RULE}.`,
        }
      : {
          code: "PROFILE_TOKEN_MALFORMED",
          exitCode: EXIT_CODES.auth,
          hint,
          message: `The token of profile "${profile.name}" in ${token.variable} is malformed: ${BEARER_TOKEN_RULE}.`,
        },
  );
}

/** The inline token, else the value of the profile's token variable, which it names. */
function storedToken(
  profile: StoredProfile,
  env: NodeJS.ProcessEnv,
): { readonly value: string; readonly variable: string | null } | null {
  if (profile.token !== undefined && profile.token.length > 0) {
    return { value: profile.token, variable: null };
  }
  if (profile.tokenEnv === undefined) return null;
  const value = env[profile.tokenEnv];
  return value !== undefined && value.length > 0 ? { value, variable: profile.tokenEnv } : null;
}

export function upsertProfile(config: ProfileConfig, profile: StoredProfile): ProfileConfig {
  return {
    ...(config.defaultProfile !== undefined ? { defaultProfile: config.defaultProfile } : {}),
    profiles: { ...config.profiles, [profile.name]: profile },
  };
}

export function removeProfile(config: ProfileConfig, name: string): ProfileConfig {
  const next: Record<string, StoredProfile> = { ...config.profiles };
  delete next[name];
  return {
    ...(config.defaultProfile !== undefined && config.defaultProfile !== name
      ? { defaultProfile: config.defaultProfile }
      : {}),
    profiles: next,
  };
}

export function setDefaultProfile(config: ProfileConfig, name: string): ProfileConfig {
  if (config.profiles[name] === undefined) {
    throw new AgentError({
      code: "PROFILE_NOT_FOUND",
      message: `Profile "${name}" is not configured.`,
      fixCommand: "swizzle profile list",
      details: { available: Object.keys(config.profiles) },
    });
  }
  return { defaultProfile: name, profiles: config.profiles };
}

export function parseProfileToml(raw: string): ProfileConfig {
  const profiles: Record<string, StoredProfile> = {};
  let defaultProfile: string | undefined;
  let section: { kind: "root" } | { kind: "profile"; name: string } = { kind: "root" };
  const buffers: Record<
    string,
    {
      name: string;
      url?: string;
      token?: string;
      tokenEnv?: string;
      environment?: string;
      project?: string;
    }
  > = {};

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (line.length === 0) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const header1 = header[1];
      if (header1 === undefined) continue;
      const headerPath = header1.trim();
      if (headerPath.startsWith("profile.")) {
        const name = headerPath.slice("profile.".length).trim();
        if (name.length === 0) {
          throw new Error(`Profile section must have a name (line ${i + 1}).`);
        }
        section = { kind: "profile", name };
        if (buffers[name] === undefined) buffers[name] = { name };
        continue;
      }
      section = { kind: "root" };
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!kv) continue;
    const rawKey = kv[1];
    const rawValue = kv[2];
    if (rawKey === undefined || rawValue === undefined) continue;
    const key = rawKey;
    const value = unquote(rawValue);

    if (section.kind === "root") {
      if (key === "default_profile") defaultProfile = value;
      continue;
    }

    const buffer = buffers[section.name];
    if (buffer === undefined) continue;
    if (key === "url") buffer.url = value;
    else if (key === "token") buffer.token = value;
    else if (key === "token_env") buffer.tokenEnv = value;
    else if (key === "env") buffer.environment = value;
    else if (key === "project") buffer.project = value;
  }

  for (const [name, buffer] of Object.entries(buffers)) {
    if (!buffer.url) {
      throw new Error(`Profile "${name}" is missing required field "url".`);
    }
    profiles[name] = {
      name,
      url: buffer.url,
      ...(buffer.token !== undefined ? { token: buffer.token } : {}),
      ...(buffer.tokenEnv !== undefined ? { tokenEnv: buffer.tokenEnv } : {}),
      ...(buffer.environment !== undefined ? { environment: buffer.environment } : {}),
      ...(buffer.project !== undefined ? { project: buffer.project } : {}),
    };
  }

  return {
    ...(defaultProfile !== undefined ? { defaultProfile } : {}),
    profiles,
  };
}

export function serializeProfileToml(config: ProfileConfig): string {
  const lines: string[] = ["# Swizzle CLI profiles", "# See: swizzle profile --help", ""];
  if (config.defaultProfile !== undefined) {
    lines.push(`default_profile = ${quote(config.defaultProfile)}`);
    lines.push("");
  }
  const names = Object.keys(config.profiles).sort();
  for (const name of names) {
    const profile = config.profiles[name];
    if (profile === undefined) continue;
    lines.push(`[profile.${name}]`);
    lines.push(`url = ${quote(profile.url)}`);
    if (profile.environment !== undefined) {
      lines.push(`env = ${quote(profile.environment)}`);
    }
    if (profile.project !== undefined) {
      lines.push(`project = ${quote(profile.project)}`);
    }
    if (profile.token !== undefined) {
      lines.push(`token = ${quote(profile.token)}`);
    }
    if (profile.tokenEnv !== undefined) {
      lines.push(`token_env = ${quote(profile.tokenEnv)}`);
    }
    lines.push("");
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function redactedView(profile: StoredProfile): Record<string, unknown> {
  return {
    name: profile.name,
    url: profile.url,
    environment: profile.environment ?? null,
    project: profile.project ?? null,
    tokenSource: profile.token !== undefined ? "inline" : (profile.tokenEnv ?? "none"),
    hasToken: storedToken(profile, process.env) !== null,
  };
}

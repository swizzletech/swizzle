import { AUTOMATION_ENV_NAME_PATTERN } from "@swizzle/config";
import {
  CodedError,
  type ControlPlaneStore,
  type CredentialPlace,
  type CredentialState,
  type ResolvedSecret,
  SecretConfigurationError,
  type SecretView,
  type StoredCredential,
  type StoredDeployment,
  type StoredSecret,
  type StoredTrigger,
  type Subject,
} from "@swizzle/db";

import {
  boundCredentialsNamed,
  type CredentialHolder,
  credentialStates,
} from "./deployment-credentials.js";
import { AutomationRuntimeError } from "./errors.js";
import type { ResolvedConnectionToken } from "./platform-connections.js";
import { CONNECTION_ENV_PREFIX, connectionEnvVarName } from "./platform-connections.js";
import type { PlatformSecretStatusRecord } from "./platform-records.js";

export type PlatformSecretRecord = StoredSecret;

const PLATFORM_BASE_ENV_ALLOWLIST = new Set([
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "IS_SANDBOX",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PWD",
  "REQUESTS_CA_BUNDLE",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

export async function deletePlatformSecret(options: {
  readonly secretId: string;
  readonly store: ControlPlaneStore;
}): Promise<boolean> {
  try {
    return await options.store.deleteSecret(options.secretId);
  } catch (error) {
    throw mapSecretStoreError(error);
  }
}

export async function getPlatformSecret(options: {
  readonly name: string;
  readonly place: CredentialPlace;
  readonly store: ControlPlaneStore;
}): Promise<SecretView | null> {
  try {
    return await options.store.getSecret(options.name, options.place);
  } catch (error) {
    throw mapSecretStoreError(error);
  }
}

export async function listPlatformSecrets(options: {
  readonly environment: string;
  readonly projectIds: readonly string[] | "all";
  readonly store: ControlPlaneStore;
}): Promise<readonly SecretView[]> {
  try {
    return await options.store.listSecrets(options.environment, options.projectIds);
  } catch (error) {
    throw mapSecretStoreError(error);
  }
}

export async function upsertPlatformSecret(options: {
  readonly creator?: Subject;
  readonly name: string;
  readonly place: CredentialPlace;
  readonly replaces?: string | null;
  readonly store: ControlPlaneStore;
  readonly value: string;
}): Promise<PlatformSecretRecord> {
  if (!AUTOMATION_ENV_NAME_PATTERN.test(options.name)) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      `Secret names must be uppercase env names matching ${AUTOMATION_ENV_NAME_PATTERN.source}: ${options.name}`,
      { details: { name: options.name } },
    );
  }
  if (options.name.startsWith(CONNECTION_ENV_PREFIX)) {
    throw new AutomationRuntimeError(
      "SECRET_NAME_RESERVED",
      `Secret names starting with ${CONNECTION_ENV_PREFIX} are reserved for platform connection injection. Use a different name.`,
      { details: { name: options.name } },
    );
  }

  try {
    return await options.store.upsertSecret({
      ...options.place,
      ...(options.creator !== undefined ? { creator: options.creator } : {}),
      name: options.name,
      ...(options.replaces !== undefined ? { replaces: options.replaces } : {}),
      value: options.value,
    });
  } catch (error) {
    throw mapSecretStoreError(error);
  }
}

export async function getDeploymentSecretHealth(options: {
  readonly deployment: StoredDeployment;
  readonly store: ControlPlaneStore;
}): Promise<readonly PlatformSecretStatusRecord[]> {
  const { deployment, store } = options;
  const states = await credentialStates({
    deployment,
    kind: "secret",
    names: deployment.config.secrets,
    store,
  });
  try {
    const bound = states.flatMap(({ credential }) => (credential === null ? [] : [credential]));
    const projectIds = [...new Set(bound.map((secret) => secret.projectId))];
    const secrets =
      projectIds.length === 0 ? [] : await store.listSecrets(deployment.environment, projectIds);
    const byId = new Map(secrets.map((secret) => [secret.id, secret]));
    return states.map(({ credential, name, state }) =>
      mapSecretStatus(
        name,
        deployment.environment,
        state,
        credential === null ? null : (byId.get(credential.id) ?? null),
      ),
    );
  } catch (error) {
    throw mapSecretStoreError(error);
  }
}

export async function ensureDeploymentSecretsPresent(options: {
  readonly deployment: StoredDeployment;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  await requireBoundSecrets({
    automationName: options.deployment.automationName,
    environment: options.deployment.environment,
    holder: options.deployment,
    secretNames: options.deployment.config.secrets,
    store: options.store,
  });
}

export async function ensureTriggerSecretsPresent(options: {
  readonly store: ControlPlaneStore;
  readonly trigger: StoredTrigger;
}): Promise<void> {
  await requireBoundSecrets({
    automationName: options.trigger.automationName,
    environment: options.trigger.environment,
    holder: options.trigger,
    secretNames: options.trigger.config.secrets,
    store: options.store,
  });
}

/** The allowlisted variables of the executing machine that a deployed run's process inherits. */
export function platformBaseEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined && PLATFORM_BASE_ENV_ALLOWLIST.has(key)) base[key] = value;
  return base;
}

/**
 * The values the server injects into one execution, and nothing of its own environment: the
 * executing machine adds its base (platformBaseEnvironment), so a remote worker never receives
 * the API's PATH or HOME.
 */
export function buildPlatformChildEnvironment(options: {
  readonly connections?: readonly ResolvedConnectionToken[];
  /** `SWIZZLE_LINK_URL` and `SWIZZLE_LINK_KEY`, with which the run signs its approval and event links. */
  readonly links?: Readonly<Record<string, string>>;
  readonly secrets: readonly ResolvedSecret[];
}): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};

  for (const secret of options.secrets) {
    childEnvironment[secret.name] = secret.value;
  }

  Object.assign(childEnvironment, options.links);

  // Connections inject only the short-lived access token; refresh tokens and
  // client credentials never reach user code.
  for (const connection of options.connections ?? []) {
    const envVarName = connectionEnvVarName(connection.name);
    childEnvironment[envVarName] = connection.accessToken;
    if (connection.accessTokenExpiresAt !== null) {
      childEnvironment[`${envVarName}_EXPIRES_AT`] = connection.accessTokenExpiresAt;
    }
  }

  return childEnvironment;
}

/** The named secrets a deployment bound, decrypted; throws PLATFORM_REQUIRED_SECRETS_MISSING for a lost one. */
export async function resolveRequiredSecrets(options: {
  readonly automationName: string;
  readonly environment: string;
  readonly holder: CredentialHolder;
  readonly secretNames: readonly string[];
  readonly store: ControlPlaneStore;
}): Promise<readonly ResolvedSecret[]> {
  const bound = await requireBoundSecrets(options);
  if (bound.length === 0) return [];
  let resolved: readonly ResolvedSecret[];
  try {
    resolved = await options.store.resolveSecrets(bound.map((secret) => secret.id));
  } catch (error) {
    throw mapSecretStoreError(error);
  }
  // A secret deleted after the binding check resolves to nothing; the run must not start without it.
  const found = new Set(resolved.map((secret) => secret.id));
  const lost = bound.filter((secret) => !found.has(secret.id)).map((secret) => secret.name);
  if (lost.length > 0) throw secretsLost(options, lost);
  return resolved;
}

function secretsLost(
  options: { readonly automationName: string; readonly environment: string },
  missing: readonly string[],
): AutomationRuntimeError {
  return new AutomationRuntimeError(
    "PLATFORM_REQUIRED_SECRETS_MISSING",
    `Automation ${options.automationName} has lost platform secrets in environment ${options.environment}: ${missing.join(", ")}. Each was deleted, its share was revoked, or the automation moved away from it. Set them and deploy again.`,
    { details: { environment: options.environment, missingSecrets: missing } },
  );
}

async function requireBoundSecrets(options: {
  readonly automationName: string;
  readonly environment: string;
  readonly holder: CredentialHolder;
  readonly secretNames: readonly string[];
  readonly store: ControlPlaneStore;
}): Promise<readonly StoredCredential[]> {
  const { bound, missing } = await boundCredentialsNamed({
    holder: options.holder,
    kind: "secret",
    names: options.secretNames,
    store: options.store,
  });
  if (missing.length > 0) throw secretsLost(options, missing);
  return bound;
}

function mapSecretStatus(
  name: string,
  environment: string,
  state: CredentialState,
  secret: StoredSecret | null,
): PlatformSecretStatusRecord {
  return {
    algorithm: secret?.algorithm ?? null,
    createdAt: secret?.createdAt ?? null,
    environment,
    keyVersion: secret?.keyVersion ?? null,
    name,
    state,
    secretVersion: secret?.secretVersion ?? null,
    updatedAt: secret?.updatedAt ?? null,
  };
}

function mapSecretStoreError(error: unknown): Error {
  if (error instanceof AutomationRuntimeError) {
    return error;
  }

  if (
    error instanceof CodedError &&
    (error.code === "SECRET_ALREADY_EXISTS" || error.code === "CREDENTIAL_CHANGED")
  ) {
    return new AutomationRuntimeError(error.code, error.message, {
      cause: error,
      ...(error.details ? { details: error.details } : {}),
    });
  }

  if (error instanceof SecretConfigurationError) {
    switch (error.code) {
      case "MISSING_ENCRYPTION_KEY":
        return new AutomationRuntimeError("MISSING_ENCRYPTION_KEY", error.message, {
          cause: error,
        });
      case "INVALID_ENCRYPTION_KEY":
        return new AutomationRuntimeError("INVALID_ENCRYPTION_KEY", error.message, {
          cause: error,
        });
    }
  }

  return error instanceof Error
    ? error
    : new AutomationRuntimeError(
        "UNEXPECTED_RUNTIME_ERROR",
        typeof error === "string" ? error : "Unexpected platform secret store error.",
      );
}

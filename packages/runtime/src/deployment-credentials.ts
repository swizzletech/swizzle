import { declaredCredentialNames } from "@swizzle/config";
import {
  CodedError,
  type ControlPlaneStore,
  type CredentialKind,
  type CredentialPlace,
  type CredentialState,
  type DeclaredCredentials,
  type DeploymentCredential,
  type StoredCredential,
} from "@swizzle/db";

import { AutomationRuntimeError } from "./errors.js";

export interface CredentialHolder {
  readonly deploymentId: string;
  readonly projectId: string;
}

export async function boundCredentialsNamed(options: {
  readonly holder: CredentialHolder;
  readonly kind: CredentialKind;
  readonly names: readonly string[];
  readonly store: ControlPlaneStore;
}): Promise<{
  readonly bound: readonly StoredCredential[];
  readonly missing: readonly string[];
}> {
  if (options.names.length === 0) return { bound: [], missing: [] };
  const all = await options.store.boundCredentials(
    options.holder.deploymentId,
    options.holder.projectId,
  );
  const byName = new Map(
    all.flatMap((credential) =>
      credential.kind === options.kind ? [[credential.name, credential] as const] : [],
    ),
  );
  const names = [...new Set(options.names)];
  return {
    bound: names.flatMap((name) => {
      const credential = byName.get(name);
      return credential === undefined ? [] : [credential];
    }),
    missing: names.filter((name) => !byName.has(name)),
  };
}

export type DeclaredCredentialState =
  | { readonly credential: StoredCredential; readonly name: string; readonly state: "bound" }
  | {
      readonly credential: null;
      readonly name: string;
      readonly state: Exclude<CredentialState, "bound">;
    };

export async function credentialStates(options: {
  readonly deployment: CredentialHolder & { readonly environment: string };
  readonly kind: CredentialKind;
  readonly names: readonly string[];
  readonly store: ControlPlaneStore;
}): Promise<readonly DeclaredCredentialState[]> {
  const { deployment, kind, store } = options;
  const { bound } = await boundCredentialsNamed({ ...options, holder: deployment });
  const deployableNow = async (name: string) =>
    await store
      .findDeploymentCredentials({
        connections: kind === "connection" ? [name] : [],
        place: { environment: deployment.environment, projectId: deployment.projectId },
        secrets: kind === "secret" ? [name] : [],
      })
      .then(
        (found) => found.length > 0,
        (error: unknown) => {
          if (error instanceof CodedError && error.code === "CREDENTIAL_AMBIGUOUS") {
            return true;
          }
          throw error;
        },
      );
  return await Promise.all(
    options.names.map(async (name): Promise<DeclaredCredentialState> => {
      const credential = bound.find((candidate) => candidate.name === name);
      if (credential !== undefined) return { credential, name, state: "bound" };
      return { credential: null, name, state: (await deployableNow(name)) ? "unbound" : "missing" };
    }),
  );
}

export async function findDeclaredCredentials(options: {
  readonly config: {
    readonly connections: readonly string[];
    readonly secrets: readonly string[];
    readonly trigger: {
      readonly type: string;
      readonly signature?: { readonly secret: string } | undefined;
    };
  };
  readonly place: CredentialPlace;
  readonly store: ControlPlaneStore;
}): Promise<readonly DeploymentCredential[]> {
  const { place } = options;
  const declared: DeclaredCredentials = { ...declaredCredentialNames(options.config), place };
  const found = await options.store.findDeploymentCredentials(declared).catch((error: unknown) => {
    if (error instanceof CodedError && error.code === "CREDENTIAL_AMBIGUOUS") {
      throw new AutomationRuntimeError(error.code, error.message, {
        cause: error,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    throw error;
  });
  const missing = (kind: CredentialKind, names: readonly string[]) =>
    names.filter(
      (name) =>
        !found.some(({ credential }) => credential.kind === kind && credential.name === name),
    );
  const missingSecrets = missing("secret", declared.secrets);
  if (missingSecrets.length > 0) {
    throw new AutomationRuntimeError(
      "PLATFORM_REQUIRED_SECRETS_MISSING",
      `This version uses platform secrets that are not set in environment ${place.environment}: ${missingSecrets.join(", ")}. Set them before deploying with: swizzle secret set <name>`,
      { details: { environment: place.environment, missingSecrets } },
    );
  }
  const missingConnections = missing("connection", declared.connections);
  if (missingConnections.length > 0) {
    throw new AutomationRuntimeError(
      "PLATFORM_REQUIRED_CONNECTIONS_MISSING",
      `This version uses platform connections that do not exist in environment ${place.environment}: ${missingConnections.join(", ")}. Create them before deploying with: swizzle connections authorize <name>`,
      { details: { environment: place.environment, missingConnections } },
    );
  }
  return found;
}

export async function bindsExactly(
  store: ControlPlaneStore,
  holder: CredentialHolder,
  credentials: readonly DeploymentCredential[],
): Promise<boolean> {
  const bound = await store.boundCredentials(holder.deploymentId, holder.projectId);
  const key = (credential: StoredCredential) => `${credential.kind}:${credential.id}`;
  const boundKeys = new Set(bound.map(key));
  return (
    boundKeys.size === credentials.length &&
    credentials.every(({ credential }) => boundKeys.has(key(credential)))
  );
}

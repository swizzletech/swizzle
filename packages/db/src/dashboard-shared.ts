import type { AutomationConfig } from "@swizzle/config";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { inScope, type ReadScope } from "./access.js";
import type {
  CredentialState,
  StoredArtifactLocator,
  StoredArtifactStorageBackend,
} from "./control-plane-types.js";
import type { DashboardSecretStatus } from "./dashboard-types.js";
import { automations, runs } from "./schema.js";

export const inCurrentProject = sql`${runs.projectId} = ${automations.projectId}`;

export function automationsInScope(scope: ReadScope): SQL | undefined {
  return ownedInScope(scope, { automationId: automations.id, projectId: automations.projectId });
}

export function ownedInScope(
  scope: ReadScope,
  owner: { readonly automationId: AnyPgColumn; readonly projectId: AnyPgColumn },
): SQL | undefined {
  if (scope.all) return undefined;
  return or(
    inArray(owner.projectId, [...scope.projectIds]),
    ...scope.automations.map((shared) =>
      and(eq(owner.automationId, shared.automationId), eq(owner.projectId, shared.projectId)),
    ),
  );
}

export function normalizeStoredArtifactLocator(
  artifactBackend: string,
  artifactLocator: unknown,
  artifactRootPath: string,
): StoredArtifactLocator {
  if (artifactBackend === "s3") {
    const locator = artifactLocator as Partial<
      Extract<StoredArtifactLocator, { type: "s3" }>
    > | null;
    if (
      locator?.type === "s3" &&
      typeof locator.bucket === "string" &&
      typeof locator.keyPrefix === "string" &&
      typeof locator.region === "string"
    ) {
      return {
        bucket: locator.bucket,
        endpoint: typeof locator.endpoint === "string" ? locator.endpoint : null,
        forcePathStyle: Boolean(locator.forcePathStyle),
        keyPrefix: locator.keyPrefix,
        region: locator.region,
        type: "s3",
      };
    }

    throw new Error(`Stored S3 artifact locator is invalid for ${artifactRootPath}`);
  }

  const locator = artifactLocator as Partial<
    Extract<StoredArtifactLocator, { type: "local" }>
  > | null;
  if (
    locator?.type === "local" &&
    typeof locator.artifactsDirectory === "string" &&
    typeof locator.relativeRootPath === "string"
  ) {
    return {
      artifactsDirectory: locator.artifactsDirectory,
      relativeRootPath: locator.relativeRootPath,
      type: "local",
    };
  }

  throw new Error(`Stored local artifact locator is invalid for ${artifactRootPath}`);
}

export function mapSecretHealth(
  secretNames: readonly string[],
  environment: string,
  secretsByName: ReadonlyMap<
    string,
    {
      readonly algorithm: string;
      readonly createdAt: Date;
      readonly environment: string;
      readonly keyVersion: string;
      readonly name: string;
      readonly secretVersion: number;
      readonly updatedAt: Date;
    }
  >,
  deployable: (name: string) => boolean,
): readonly DashboardSecretStatus[] {
  return secretNames.map((secretName) => {
    const secret = secretsByName.get(secretName);
    return {
      algorithm: secret?.algorithm ?? null,
      createdAt: secret?.createdAt.toISOString() ?? null,
      environment,
      keyVersion: secret?.keyVersion ?? null,
      name: secretName,
      state: secretState(secret !== undefined, deployable(secretName)),
      secretVersion: secret?.secretVersion ?? null,
      updatedAt: secret?.updatedAt.toISOString() ?? null,
    } satisfies DashboardSecretStatus;
  });
}

function secretState(bound: boolean, deployable: boolean): CredentialState {
  if (bound) return "bound";
  return deployable ? "unbound" : "missing";
}

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

export function asAutomationConfig(input: unknown): AutomationConfig {
  return input as AutomationConfig;
}

export function asMetadata(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

export function asArtifactStorageBackend(input: string): StoredArtifactStorageBackend {
  return input as StoredArtifactStorageBackend;
}

export interface ChainSource {
  readonly automationId: string;
  readonly name: string;
  readonly projectId: string;
  readonly slug: string;
}

export function chainSourcesInScope(
  scalar: ChainSource | null,
  joined: readonly ChainSource[],
  scope: ReadScope,
): {
  readonly hidden: number;
  readonly names: readonly string[];
  readonly slugs: readonly string[];
} {
  let sources = joined;
  if (sources.length === 0 && scalar !== null) sources = [scalar];
  const visible = sources.filter((source) => inScope(scope, source));
  return {
    hidden: sources.length - visible.length,
    names: visible.map((source) => source.name),
    slugs: visible.map((source) => source.slug),
  };
}

import { and, asc, eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import { credentialChanged } from "./control-plane-errors.js";
import { mapSecretRow } from "./control-plane-read-models.js";
import type {
  CredentialPlace,
  RecordRunExecutionSecretUsagesInput,
  ResolvedSecret,
  SecretView,
  StoredSecret,
  UpsertSecretInput,
} from "./control-plane-types.js";
import { subjectValues } from "./grant-subject.js";
import { projectRefColumns } from "./project-ref-columns.js";
import {
  credentialGrants,
  environmentSecrets,
  projects,
  runExecutionSecretUsages,
} from "./schema.js";
import { decryptSecretValue, encryptSecretValue } from "./secrets.js";

const secretColumns = {
  algorithm: environmentSecrets.algorithm,
  id: environmentSecrets.id,
  createdAt: environmentSecrets.createdAt,
  environment: environmentSecrets.environment,
  keyVersion: environmentSecrets.keyVersion,
  name: environmentSecrets.name,
  projectId: environmentSecrets.projectId,
  secretVersion: environmentSecrets.secretVersion,
  updatedAt: environmentSecrets.updatedAt,
};

function inPlace(place: CredentialPlace) {
  return and(
    eq(environmentSecrets.projectId, place.projectId),
    eq(environmentSecrets.environment, place.environment),
  );
}

export async function deleteSecret(client: DatabaseClient, secretId: string): Promise<boolean> {
  const deletedSecrets = await client.db
    .delete(environmentSecrets)
    .where(eq(environmentSecrets.id, secretId))
    .returning({ id: environmentSecrets.id });

  return deletedSecrets.length > 0;
}

export async function getSecret(
  client: DatabaseClient,
  name: string,
  place: CredentialPlace,
): Promise<SecretView | null> {
  const [row] = await client.db
    .select({
      ...secretColumns,
      project: projectRefColumns(projects),
    })
    .from(environmentSecrets)
    .innerJoin(projects, eq(environmentSecrets.projectId, projects.id))
    .where(and(inPlace(place), eq(environmentSecrets.name, name)))
    .limit(1);

  return row ? { ...mapSecretRow(row), project: row.project } : null;
}

export async function listSecrets(
  client: DatabaseClient,
  environment: string,
  projectIds: readonly string[] | "all",
): Promise<readonly SecretView[]> {
  const rows = await client.db
    .select({
      ...secretColumns,
      project: projectRefColumns(projects),
    })
    .from(environmentSecrets)
    .innerJoin(projects, eq(environmentSecrets.projectId, projects.id))
    .where(
      and(
        eq(environmentSecrets.environment, environment),
        projectIds === "all" ? undefined : inArray(environmentSecrets.projectId, [...projectIds]),
      ),
    )
    .orderBy(asc(environmentSecrets.name), asc(environmentSecrets.projectId));

  return rows.map((row) => ({ ...mapSecretRow(row), project: row.project }));
}

export async function upsertSecret(
  client: DatabaseClient,
  input: UpsertSecretInput,
): Promise<StoredSecret> {
  return await client.db.transaction(async (tx) => {
    // Row-level lock on any existing secret so we serialize concurrent writers. `replaces` is
    // checked against the locked row, so the write touches only the secret its caller checked.
    const [existingSecret] = await tx
      .select({
        id: environmentSecrets.id,
        secretVersion: environmentSecrets.secretVersion,
        updatedAt: environmentSecrets.updatedAt,
      })
      .from(environmentSecrets)
      .where(and(inPlace(input), eq(environmentSecrets.name, input.name)))
      .limit(1)
      .for("update");

    if (existingSecret && input.replaces === null) {
      throw alreadyExists(input, existingSecret);
    }
    if (typeof input.replaces === "string" && existingSecret?.id !== input.replaces) {
      throw credentialChanged("secret", input.name);
    }

    const encryptedValue = encryptSecretValue(input.value);
    const now = new Date();

    if (existingSecret) {
      const [updated] = await tx
        .update(environmentSecrets)
        .set({
          algorithm: encryptedValue.algorithm,
          ciphertext: encryptedValue.ciphertext,
          keyVersion: encryptedValue.keyVersion,
          secretVersion: existingSecret.secretVersion + 1,
          updatedAt: now,
        })
        .where(eq(environmentSecrets.id, existingSecret.id))
        .returning(secretColumns);
      if (updated === undefined) {
        throw new Error(`Locked secret could not be updated: ${input.environment}/${input.name}`);
      }
      return mapSecretRow(updated);
    }

    // The lock above finds no row to hold, so a concurrent create surfaces here.
    const [inserted] = await tx
      .insert(environmentSecrets)
      .values({
        algorithm: encryptedValue.algorithm,
        ciphertext: encryptedValue.ciphertext,
        createdAt: now,
        environment: input.environment,
        keyVersion: encryptedValue.keyVersion,
        name: input.name,
        projectId: input.projectId,
        secretVersion: 1,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          environmentSecrets.projectId,
          environmentSecrets.environment,
          environmentSecrets.name,
        ],
      })
      .returning(secretColumns);
    if (inserted === undefined) {
      throw credentialChanged("secret", input.name);
    }
    if (input.creator !== undefined) {
      await tx
        .insert(credentialGrants)
        .values({ ...subjectValues(input.creator), role: "manage", secretId: inserted.id });
    }
    return mapSecretRow(inserted);
  });
}

function alreadyExists(
  input: UpsertSecretInput,
  existing: { readonly secretVersion: number; readonly updatedAt: Date },
): CodedError {
  return new CodedError(
    "SECRET_ALREADY_EXISTS",
    `Secret "${input.name}" already exists in ${input.environment} (version ${existing.secretVersion}, last updated ${existing.updatedAt.toISOString()}).`,
    {
      details: {
        environment: input.environment,
        name: input.name,
        secretVersion: existing.secretVersion,
        updatedAt: existing.updatedAt.toISOString(),
      },
    },
  );
}

export async function resolveSecrets(
  client: DatabaseClient,
  secretIds: readonly string[],
): Promise<readonly ResolvedSecret[]> {
  if (secretIds.length === 0) return [];
  const rows = await client.db
    .select({ ...secretColumns, ciphertext: environmentSecrets.ciphertext })
    .from(environmentSecrets)
    .where(inArray(environmentSecrets.id, [...new Set(secretIds)]))
    .orderBy(asc(environmentSecrets.name));
  return rows.map((row) => ({
    ...mapSecretRow(row),
    value: decryptSecretValue({ algorithm: row.algorithm, ciphertext: row.ciphertext }),
  }));
}

export async function recordRunExecutionSecretUsages(
  client: DatabaseClient,
  input: RecordRunExecutionSecretUsagesInput,
): Promise<void> {
  if (input.secretUsages.length === 0) {
    return;
  }

  const injectedAt = new Date(input.injectedAt ?? new Date().toISOString());
  await client.db.insert(runExecutionSecretUsages).values(
    input.secretUsages.map((secretUsage) => ({
      algorithm: secretUsage.algorithm,
      executionNumber: input.executionNumber,
      environment: secretUsage.environment,
      injectedAt,
      keyVersion: secretUsage.keyVersion,
      runId: input.runId,
      secretName: secretUsage.name,
      secretVersion: secretUsage.secretVersion,
    })),
  );
}

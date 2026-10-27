/**
 * Credential grants, shares and deployment bindings over PostgreSQL (ADR 0014). access.ts decides
 * what they allow; this module only reads and writes them. A secret and a connection are both a
 * credential: each row names one by `secret_id` or `connection_id`.
 */

import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { CredentialGrant, CredentialKind, Subject } from "./access.js";
import { causeCode, type DatabaseClient, PG_ERROR } from "./client.js";
import { CodedError } from "./coded-error.js";
import type {
  CredentialAccess,
  CredentialPlace,
  CredentialShare,
  DeclaredCredentials,
  DeploymentCredential,
  StoredCredential,
} from "./control-plane-types.js";
import { namesSubject, subjectColumn, subjectOfRow, subjectValues } from "./grant-subject.js";
import { projectRefColumns } from "./project-ref-columns.js";
import {
  credentialGrants,
  credentialShares,
  deploymentCredentials,
  environmentConnections,
  environmentSecrets,
  projects,
} from "./schema.js";

type Transaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];
type Executor = DatabaseClient["db"] | Transaction;

const TABLES = { connection: environmentConnections, secret: environmentSecrets } as const;
const COLUMN = { connection: "connectionId", secret: "secretId" } as const;

function credentialColumns(kind: CredentialKind) {
  const table = TABLES[kind];
  return {
    environment: table.environment,
    id: table.id,
    name: table.name,
    projectId: table.projectId,
  };
}

function asCredential(
  kind: CredentialKind,
  row: { id: string; name: string; projectId: string; environment: string },
): StoredCredential {
  return {
    environment: row.environment,
    id: row.id,
    kind,
    name: row.name,
    projectId: row.projectId,
  };
}

/** The `secret_id` or `connection_id` column of a credential row. */
function credentialIs(
  table: typeof credentialGrants | typeof credentialShares | typeof deploymentCredentials,
  credential: Pick<StoredCredential, "id" | "kind">,
) {
  return eq(table[COLUMN[credential.kind]], credential.id);
}

function credentialValues(credential: Pick<StoredCredential, "id" | "kind">) {
  return credential.kind === "secret"
    ? { connectionId: null, secretId: credential.id }
    : { connectionId: credential.id, secretId: null };
}

export async function findCredential(
  client: DatabaseClient,
  kind: CredentialKind,
  name: string,
  place: CredentialPlace,
): Promise<StoredCredential | null> {
  const table = TABLES[kind];
  const [row] = await client.db
    .select(credentialColumns(kind))
    .from(table)
    .where(
      and(
        eq(table.projectId, place.projectId),
        eq(table.environment, place.environment),
        eq(table.name, name),
      ),
    )
    .limit(1);
  return row === undefined ? null : asCredential(kind, row);
}

export async function credentialAccess(
  client: DatabaseClient,
  credentials: readonly StoredCredential[],
): Promise<readonly CredentialAccess[]> {
  if (credentials.length === 0) return [];
  const ids = (kind: CredentialKind) =>
    credentials.flatMap((credential) => (credential.kind === kind ? [credential.id] : []));
  const among = (table: typeof credentialGrants | typeof credentialShares) =>
    or(
      ids("secret").length > 0 ? inArray(table.secretId, ids("secret")) : undefined,
      ids("connection").length > 0 ? inArray(table.connectionId, ids("connection")) : undefined,
    );
  const [grantRows, shares] = await Promise.all([
    client.db.select().from(credentialGrants).where(among(credentialGrants)),
    loadShares(client.db, among(credentialShares)),
  ]);
  return credentials.map((credential) => ({
    credential,
    grants: grantRows
      .filter((row) => row[COLUMN[credential.kind]] === credential.id)
      .map((row) => ({
        right: row.role,
        subject: subjectOfRow(row),
      })),
    shares: shares.filter(
      (share) => share.credential.kind === credential.kind && share.credential.id === credential.id,
    ),
  }));
}

export async function setCredentialGrant(
  client: DatabaseClient,
  credential: StoredCredential,
  grant: CredentialGrant,
): Promise<void> {
  // One statement, so two first grants to the same subject cannot both insert.
  await client.db
    .insert(credentialGrants)
    .values({
      ...credentialValues(credential),
      ...subjectValues(grant.subject),
      role: grant.right,
    })
    .onConflictDoUpdate({
      set: { role: grant.right },
      target: [
        credentialGrants[COLUMN[credential.kind]],
        subjectColumn(credentialGrants, grant.subject),
      ],
    });
}

export async function removeCredentialGrant(
  client: DatabaseClient,
  credential: StoredCredential,
  subject: Subject,
): Promise<boolean> {
  const removed = await client.db
    .delete(credentialGrants)
    .where(and(credentialIs(credentialGrants, credential), namesSubject(credentialGrants, subject)))
    .returning({ id: credentialGrants.id });
  return removed.length > 0;
}

export async function offerCredentialShare(
  client: DatabaseClient,
  input: {
    readonly credential: StoredCredential;
    readonly projectId: string;
    readonly offeredBy: string | null;
    readonly accepted: boolean;
  },
): Promise<CredentialShare> {
  const matches = and(
    credentialIs(credentialShares, input.credential),
    eq(credentialShares.projectId, input.projectId),
  );
  await client.db
    .insert(credentialShares)
    .values({
      ...credentialValues(input.credential),
      offeredBy: input.offeredBy,
      projectId: input.projectId,
    })
    .onConflictDoNothing();
  if (input.accepted) {
    await client.db
      .update(credentialShares)
      .set({ acceptedAt: new Date(), acceptedBy: input.offeredBy })
      .where(and(matches, isNull(credentialShares.acceptedAt)));
  }
  const [share] = await loadShares(client.db, matches);
  if (share === undefined) throw new Error("The offered share could not be reloaded.");
  return share;
}

export async function acceptCredentialShare(
  client: DatabaseClient,
  input: {
    readonly shareId: string;
    readonly projectId: string;
    readonly acceptedBy: string | null;
  },
): Promise<CredentialShare | null> {
  const matches = and(
    eq(credentialShares.id, input.shareId),
    eq(credentialShares.projectId, input.projectId),
  );
  const [share] = await loadShares(client.db, matches);
  if (share === undefined) return null;
  if (share.acceptedAt !== null) return share;
  await client.db
    .update(credentialShares)
    .set({ acceptedAt: new Date(), acceptedBy: input.acceptedBy })
    .where(matches);
  const [accepted] = await loadShares(client.db, matches);
  return accepted ?? null;
}

export async function removeCredentialShare(
  client: DatabaseClient,
  shareId: string,
): Promise<boolean> {
  const removed = await client.db
    .delete(credentialShares)
    .where(eq(credentialShares.id, shareId))
    .returning({ id: credentialShares.id });
  return removed.length > 0;
}

export async function listCredentialShares(
  client: DatabaseClient,
  projectId: string,
): Promise<readonly CredentialShare[]> {
  return await loadShares(client.db, eq(credentialShares.projectId, projectId));
}

export async function findDeploymentCredentials(
  client: DatabaseClient,
  declared: DeclaredCredentials,
): Promise<readonly DeploymentCredential[]> {
  const [secrets, connections] = await Promise.all([
    findDeployable(client, "secret", declared.secrets, declared.place),
    findDeployable(client, "connection", declared.connections, declared.place),
  ]);
  return [...secrets, ...connections];
}

/** Each name's own credential in the place, else the one shared into the place's project. */
async function findDeployable(
  client: DatabaseClient,
  kind: CredentialKind,
  names: readonly string[],
  place: CredentialPlace,
): Promise<readonly DeploymentCredential[]> {
  if (names.length === 0) return [];
  const table = TABLES[kind];
  const [own, shared] = await Promise.all([
    client.db
      .select(credentialColumns(kind))
      .from(table)
      .where(
        and(
          eq(table.projectId, place.projectId),
          eq(table.environment, place.environment),
          inArray(table.name, [...names]),
        ),
      ),
    client.db
      .select({ ...credentialColumns(kind), shareId: credentialShares.id })
      .from(credentialShares)
      .innerJoin(table, eq(credentialShares[COLUMN[kind]], table.id))
      .where(
        and(
          eq(credentialShares.projectId, place.projectId),
          isNotNull(credentialShares.acceptedAt),
          eq(table.environment, place.environment),
          inArray(table.name, [...names]),
        ),
      ),
  ]);
  return [...new Set(names)].flatMap((name): DeploymentCredential[] => {
    const mine = own.find((row) => row.name === name);
    if (mine !== undefined) return [{ credential: asCredential(kind, mine), shareId: null }];
    const offered = shared.filter((row) => row.name === name);
    if (offered.length > 1) {
      throw new CodedError(
        "CREDENTIAL_AMBIGUOUS",
        `Several projects share a ${kind} named ${name} with this project. Drop all but one share, or create the ${kind} in this project.`,
        { details: { kind, name } },
      );
    }
    const [row] = offered;
    return row === undefined ? [] : [{ credential: asCredential(kind, row), shareId: row.shareId }];
  });
}

export async function boundCredentials(
  client: DatabaseClient,
  deploymentId: string,
  projectId: string,
): Promise<readonly StoredCredential[]> {
  const bound = async (kind: CredentialKind) => {
    const table = TABLES[kind];
    const rows = await client.db
      .select(credentialColumns(kind))
      .from(deploymentCredentials)
      .innerJoin(table, eq(deploymentCredentials[COLUMN[kind]], table.id))
      .leftJoin(credentialShares, eq(credentialShares.id, deploymentCredentials.shareId))
      .where(
        and(
          eq(deploymentCredentials.deploymentId, deploymentId),
          or(eq(table.projectId, projectId), eq(credentialShares.projectId, projectId)),
        ),
      );
    return rows.map((row) => asCredential(kind, row));
  };
  return [...(await bound("secret")), ...(await bound("connection"))];
}

/** Records what a new deployment binds; fails when a credential went away since it was found. */
export async function insertDeploymentCredentials(
  tx: Transaction,
  deploymentId: string,
  credentials: readonly DeploymentCredential[],
): Promise<void> {
  if (credentials.length === 0) return;
  try {
    await tx.insert(deploymentCredentials).values(
      credentials.map(({ credential, shareId }) => ({
        ...credentialValues(credential),
        deploymentId,
        shareId,
      })),
    );
  } catch (error) {
    if (causeCode(error) !== PG_ERROR.foreignKeyViolation) throw error;
    throw new CodedError(
      "DEPLOYMENT_CREDENTIALS_CHANGED",
      "A credential this deployment binds was deleted or its share revoked while deploying. Deploy again.",
      { cause: error },
    );
  }
}

/** A rollback binds what its target still binds. */
export async function copyDeploymentCredentials(
  tx: Transaction,
  fromDeploymentId: string,
  toDeploymentId: string,
): Promise<void> {
  const rows = await tx
    .select({
      connectionId: deploymentCredentials.connectionId,
      secretId: deploymentCredentials.secretId,
      shareId: deploymentCredentials.shareId,
    })
    .from(deploymentCredentials)
    .where(eq(deploymentCredentials.deploymentId, fromDeploymentId));
  if (rows.length === 0) return;
  await tx
    .insert(deploymentCredentials)
    .values(rows.map((row) => ({ ...row, deploymentId: toDeploymentId })));
}

async function loadShares(db: Executor, where: ReturnType<typeof and>): Promise<CredentialShare[]> {
  const credentialProjects = alias(projects, "credential_projects");
  const load = async (kind: CredentialKind) => {
    const table = TABLES[kind];
    const rows = await db
      .select({
        acceptedAt: credentialShares.acceptedAt,
        acceptedBy: credentialShares.acceptedBy,
        createdAt: credentialShares.createdAt,
        credential: { environment: table.environment, id: table.id, name: table.name },
        credentialProject: projectRefColumns(credentialProjects),
        project: projectRefColumns(projects),
        offeredBy: credentialShares.offeredBy,
        shareId: credentialShares.id,
      })
      .from(credentialShares)
      .innerJoin(table, eq(credentialShares[COLUMN[kind]], table.id))
      .innerJoin(projects, eq(projects.id, credentialShares.projectId))
      .innerJoin(credentialProjects, eq(credentialProjects.id, table.projectId))
      .where(where);
    return rows.map(
      (row): CredentialShare => ({
        acceptedAt: row.acceptedAt?.toISOString() ?? null,
        acceptedBy: row.acceptedBy,
        createdAt: row.createdAt.toISOString(),
        credential: { ...row.credential, kind },
        credentialProject: row.credentialProject,
        project: row.project,
        offeredBy: row.offeredBy,
        shareId: row.shareId,
      }),
    );
  };
  return [...(await load("secret")), ...(await load("connection"))];
}

// The `automation_checks` record of an active API check and the `api_contacts` rows runs and
// checks report. A deploy writes the check row inside its transaction; a check job writes its
// outcome only while the due time it ran for is still the row's due time.
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import { deploymentCheckInput, mergeApiContact } from "./api-check-rules.js";
import type { DatabaseClient } from "./client.js";
import { toIsoString } from "./control-plane-read-models.js";
import type {
  AutomationCheckStatus,
  CompleteAutomationCheckInput,
  RecordApiContactsInput,
  StoredApiContact,
  StoredAutomationCheck,
  StoredDeployment,
} from "./control-plane-types.js";
import {
  apiContacts,
  automationChecks,
  automations,
  automationTriggers,
  deployments,
} from "./schema.js";

type ControlPlaneTransaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];

/**
 * Points the automation's check at the new deployment and makes it due at once, so every deploy
 * is checked. A new deployment starts a new failure count; the last green output stays for
 * comparison. A deployment without an active check removes the row.
 */
export async function syncDeploymentCheckInTransaction(
  tx: ControlPlaneTransaction,
  deployment: Pick<
    StoredDeployment,
    "automationId" | "config" | "deployedAt" | "deploymentId" | "environment" | "versionId"
  >,
): Promise<void> {
  const check = deploymentCheckInput(deployment);
  if (check === null) {
    await tx
      .delete(automationChecks)
      .where(
        and(
          eq(automationChecks.automationId, deployment.automationId),
          eq(automationChecks.environment, deployment.environment),
        ),
      );
    return;
  }
  const deployedAt = new Date(deployment.deployedAt);
  const reset = {
    consecutiveFailures: 0,
    deploymentId: deployment.deploymentId,
    entrypoint: check.entrypoint,
    everyMs: check.everyMs,
    failingSince: null,
    nextCheckAt: deployedAt,
    status: "pending",
    updatedAt: deployedAt,
    versionId: deployment.versionId,
  };
  await tx
    .insert(automationChecks)
    .values({
      ...reset,
      automationId: deployment.automationId,
      environment: deployment.environment,
    })
    .onConflictDoUpdate({
      set: reset,
      target: [automationChecks.automationId, automationChecks.environment],
    });
}

const checkProjection = {
  automationId: automationChecks.automationId,
  automationName: automations.name,
  automationSlug: automations.slug,
  checkId: automationChecks.id,
  consecutiveFailures: automationChecks.consecutiveFailures,
  deploymentId: automationChecks.deploymentId,
  entrypoint: automationChecks.entrypoint,
  environment: automationChecks.environment,
  everyMs: automationChecks.everyMs,
  failingSince: automationChecks.failingSince,
  lastCheckedAt: automationChecks.lastCheckedAt,
  lastExitCode: automationChecks.lastExitCode,
  lastGreenAt: automationChecks.lastGreenAt,
  lastGreenOutput: automationChecks.lastGreenOutput,
  lastGreenReport: automationChecks.lastGreenReport,
  lastOutput: automationChecks.lastOutput,
  lastReport: automationChecks.lastReport,
  lastConnectionUsages: automationChecks.lastConnectionUsages,
  lastSecretUsages: automationChecks.lastSecretUsages,
  lastStderrTail: automationChecks.lastStderrTail,
  lastWarning: automationChecks.lastWarning,
  nextCheckAt: automationChecks.nextCheckAt,
  profile: sql<string>`${deployments.runtimeSnapshot}->>'profile'`,
  status: automationChecks.status,
  versionId: automationChecks.versionId,
};

type CheckRow = Awaited<ReturnType<typeof selectChecks>>[number];

function mapCheckRow(row: CheckRow): StoredAutomationCheck {
  return {
    ...row,
    failingSince: toIsoString(row.failingSince),
    lastCheckedAt: toIsoString(row.lastCheckedAt),
    lastGreenAt: toIsoString(row.lastGreenAt),
    nextCheckAt: row.nextCheckAt.toISOString(),
    status: row.status as AutomationCheckStatus,
  };
}

function selectChecks(client: DatabaseClient) {
  return client.db
    .select(checkProjection)
    .from(automationChecks)
    .innerJoin(automations, eq(automationChecks.automationId, automations.id))
    .innerJoin(deployments, eq(automationChecks.deploymentId, deployments.id));
}

export async function getAutomationCheck(
  client: DatabaseClient,
  checkId: string,
): Promise<StoredAutomationCheck | null> {
  const [row] = await selectChecks(client).where(eq(automationChecks.id, checkId)).limit(1);
  return row === undefined ? null : mapCheckRow(row);
}

/** The checks of the automations in `automationIds`, for the dashboard. */
export async function listAutomationChecks(
  client: DatabaseClient,
  environment: string,
  automationIds: readonly string[],
): Promise<readonly StoredAutomationCheck[]> {
  if (automationIds.length === 0) return [];
  const rows = await selectChecks(client).where(
    and(
      eq(automationChecks.environment, environment),
      inArray(automationChecks.automationId, [...automationIds]),
    ),
  );
  return rows.map(mapCheckRow);
}

export async function listDueAutomationChecks(
  client: DatabaseClient,
  now: string,
  environment: string,
): Promise<readonly StoredAutomationCheck[]> {
  const rows = await selectChecks(client)
    .innerJoin(
      automationTriggers,
      and(
        eq(automationTriggers.automationId, automationChecks.automationId),
        eq(automationTriggers.environment, automationChecks.environment),
        eq(automationTriggers.status, "active"),
      ),
    )
    .where(
      and(
        eq(automationChecks.environment, environment),
        lte(automationChecks.nextCheckAt, new Date(now)),
      ),
    )
    .orderBy(asc(automationChecks.nextCheckAt));
  return rows.map(mapCheckRow);
}

export async function completeAutomationCheck(
  client: DatabaseClient,
  input: CompleteAutomationCheckInput,
): Promise<boolean> {
  const checkedAt = new Date(input.checkedAt);
  const updated = await client.db
    .update(automationChecks)
    .set({
      consecutiveFailures: input.consecutiveFailures,
      failingSince: input.failingSince === null ? null : new Date(input.failingSince),
      lastCheckedAt: checkedAt,
      lastExitCode: input.exitCode,
      lastOutput: input.output,
      lastReport: input.report,
      lastConnectionUsages: input.connectionUsages,
      lastSecretUsages: input.secretUsages,
      lastStderrTail: input.stderrTail,
      lastWarning: input.warning,
      nextCheckAt: new Date(input.nextCheckAt),
      status: input.status,
      updatedAt: checkedAt,
      ...(input.status === "green"
        ? { lastGreenAt: checkedAt, lastGreenOutput: input.output, lastGreenReport: input.report }
        : {}),
    })
    .where(
      and(
        eq(automationChecks.id, input.checkId),
        eq(automationChecks.nextCheckAt, new Date(input.dueAt)),
      ),
    )
    .returning({ id: automationChecks.id });
  return updated.length > 0;
}

export async function recordApiContacts(
  client: DatabaseClient,
  input: RecordApiContactsInput,
): Promise<readonly StoredApiContact[]> {
  if (input.contacts.length === 0) return [];
  return await client.db.transaction(async (tx) => {
    // A row lock cannot cover a host's first contact, so concurrent attempts queue on one key.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`api-contacts:${input.automationId}:${input.environment}`}, 0))`,
    );
    const hosts = input.contacts.map((contact) => contact.host);
    const existing = await tx
      .select()
      .from(apiContacts)
      .where(
        and(
          eq(apiContacts.automationId, input.automationId),
          eq(apiContacts.environment, input.environment),
          inArray(apiContacts.host, hosts),
        ),
      );
    const byHost = new Map(existing.map((row) => [row.host, mapContactRow(row)]));
    const fresh: StoredApiContact[] = [];
    for (const observation of input.contacts) {
      const { contact, newNotice } = mergeApiContact(
        byHost.get(observation.host) ?? null,
        observation,
        input,
      );
      const values = {
        deprecatedAt: toDate(contact.deprecatedAt),
        lastContactAt: new Date(contact.lastContactAt),
        lastOkAt: toDate(contact.lastOkAt),
        lastStatus: contact.lastStatus,
        noticePath: contact.noticePath,
        noticeRuns: contact.noticeRuns,
        noticeSeenAt: toDate(contact.noticeSeenAt),
        noticeUrl: contact.noticeUrl,
        sunsetAt: toDate(contact.sunsetAt),
      };
      await tx
        .insert(apiContacts)
        .values({
          ...values,
          automationId: input.automationId,
          environment: input.environment,
          host: contact.host,
        })
        .onConflictDoUpdate({
          set: values,
          target: [apiContacts.automationId, apiContacts.environment, apiContacts.host],
        });
      if (newNotice) fresh.push(contact);
    }
    return fresh;
  });
}

/** The API contacts of the automations in `automationIds`, most recent contact first. */
export async function listApiContacts(
  client: DatabaseClient,
  environment: string,
  automationIds: readonly string[],
): Promise<readonly StoredApiContact[]> {
  if (automationIds.length === 0) return [];
  const rows = await client.db
    .select()
    .from(apiContacts)
    .where(
      and(
        eq(apiContacts.environment, environment),
        inArray(apiContacts.automationId, [...automationIds]),
      ),
    )
    .orderBy(sql`${apiContacts.lastContactAt} desc`);
  return rows.map(mapContactRow);
}

function mapContactRow(row: typeof apiContacts.$inferSelect): StoredApiContact {
  return {
    ...row,
    deprecatedAt: toIsoString(row.deprecatedAt),
    lastContactAt: row.lastContactAt.toISOString(),
    lastOkAt: toIsoString(row.lastOkAt),
    noticeSeenAt: toIsoString(row.noticeSeenAt),
    sunsetAt: toIsoString(row.sunsetAt),
  };
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

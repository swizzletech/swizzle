import { and, asc, eq, lte, or } from "drizzle-orm";
import { auditEventsOf } from "./audit.js";
import { listAutomationAudit, recordTriggerChange } from "./audit-resources.js";

import type { DatabaseClient } from "./client.js";
import { CodedError } from "./coded-error.js";
import { shareLiveAutomation } from "./control-plane-automations.js";
import {
  getChainSourceAutomationIdsByTriggerId,
  getTriggerById,
  mapTriggerRow,
  triggerProjection,
} from "./control-plane-read-models.js";
import type {
  AdvanceCronTriggerCursorInput,
  CreateTriggerAuditEventInput,
  StoredTrigger,
  UpdateTriggerStatusInput,
} from "./control-plane-types.js";
import {
  automationNamed,
  automations,
  automationTriggerChainSources,
  automationTriggers,
  automationVersions,
} from "./schema.js";

type TriggerProjectionRow = Parameters<typeof mapTriggerRow>[0];

export async function advanceCronTriggerCursor(
  client: DatabaseClient,
  input: AdvanceCronTriggerCursorInput,
): Promise<boolean> {
  return await client.db.transaction(async (tx) => {
    const updatedTriggers = await tx
      .update(automationTriggers)
      .set({
        nextRunAt: new Date(input.nextRunAt),
        updatedAt: new Date(input.updatedAt),
      })
      .where(
        and(
          eq(automationTriggers.id, input.triggerId),
          eq(automationTriggers.status, "active"),
          eq(automationTriggers.nextRunAt, new Date(input.expectedNextRunAt)),
        ),
      )
      .returning();

    const trigger = updatedTriggers[0];
    if (trigger === undefined) return false;
    if (input.missed !== undefined) {
      await recordTriggerChange(tx, {
        automationId: trigger.automationId,
        deploymentId: trigger.deploymentId,
        environment: trigger.environment,
        eventType: "cron_missed",
        metadata: { ...input.missed, nextRunAt: input.nextRunAt },
        occurredAt: input.updatedAt,
        triggerId: trigger.id,
        triggerType: "cron",
      });
    }
    return true;
  });
}

export async function getChainTriggersForSource(
  client: DatabaseClient,
  sourceAutomationId: string,
  environment: string,
): Promise<readonly StoredTrigger[]> {
  const rows = await client.db
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .leftJoin(
      automationTriggerChainSources,
      eq(automationTriggerChainSources.triggerId, automationTriggers.id),
    )
    .where(
      and(
        or(
          eq(automationTriggers.chainSourceAutomationId, sourceAutomationId),
          eq(automationTriggerChainSources.sourceAutomationId, sourceAutomationId),
        ),
        eq(automationTriggers.environment, environment),
        eq(automationTriggers.triggerType, "chain"),
        eq(automationTriggers.status, "active"),
      ),
    );

  return await mapTriggerRowsWithSources(client, rows);
}

export async function getAutomationTriggerBySlug(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
): Promise<StoredTrigger | null> {
  const [row] = await client.db
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .where(and(automationNamed(automationSlug), eq(automationTriggers.environment, environment)))
    .limit(1);

  return row ? ((await mapTriggerRowsWithSources(client, [row]))[0] ?? null) : null;
}

export async function getWebhookTriggerByPath(
  client: DatabaseClient,
  webhookPath: string,
  environment: string,
): Promise<StoredTrigger | null> {
  const [row] = await client.db
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .where(
      and(
        eq(automationTriggers.environment, environment),
        eq(automationTriggers.webhookPath, webhookPath),
        eq(automationTriggers.triggerType, "webhook"),
      ),
    )
    .limit(1);

  return row ? mapTriggerRow(row) : null;
}

export async function getDueCronTriggers(
  client: DatabaseClient,
  now: string,
  environment: string,
  limit = 50,
): Promise<readonly StoredTrigger[]> {
  const rows = await client.db
    .select(triggerProjection)
    .from(automationTriggers)
    .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationTriggers.versionId, automationVersions.id))
    .where(
      and(
        eq(automationTriggers.environment, environment),
        eq(automationTriggers.triggerType, "cron"),
        eq(automationTriggers.status, "active"),
        lte(automationTriggers.nextRunAt, new Date(now)),
      ),
    )
    .orderBy(asc(automationTriggers.nextRunAt), asc(automations.slug))
    .limit(limit);

  return await mapTriggerRowsWithSources(client, rows);
}

async function mapTriggerRowsWithSources(
  client: DatabaseClient,
  rows: readonly TriggerProjectionRow[],
): Promise<readonly StoredTrigger[]> {
  const sourceIdsByTriggerId = await getChainSourceAutomationIdsByTriggerId(
    client.db,
    rows.map((row) => row.triggerId),
  );
  return rows.map((row) =>
    mapTriggerRow({
      ...row,
      chainSourceAutomationIds: sourceIdsByTriggerId.get(row.triggerId) ?? [],
    }),
  );
}

export async function createTriggerAuditEvent(
  client: DatabaseClient,
  input: CreateTriggerAuditEventInput,
): Promise<void> {
  await recordTriggerChange(client.db, input);
}

export async function listTriggerAuditEventsByAutomationSlug(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
  limit = 50,
) {
  return auditEventsOf(
    "trigger",
    await listAutomationAudit(client, automationSlug, environment, "trigger", limit, "oldest"),
  );
}

export async function updateAutomationTriggerStatus(
  client: DatabaseClient,
  input: UpdateTriggerStatusInput,
): Promise<StoredTrigger | null> {
  // Under the automation's shared row lock: a move or delete checks its triggers while it holds
  // that row, so a resume cannot turn one active between their check and their commit.
  const triggerId = await client.db.transaction(async (tx) => {
    const automation = await shareLiveAutomation(tx, automationNamed(input.automationSlug));
    if (automation === null) return null;
    const [trigger] = await tx
      .select({
        id: automationTriggers.id,
        status: automationTriggers.status,
        errorCode: automationTriggers.errorCode,
        errorMessage: automationTriggers.errorMessage,
      })
      .from(automationTriggers)
      .where(
        and(
          eq(automationTriggers.automationId, automation.id),
          eq(automationTriggers.environment, input.environment),
        ),
      )
      .for("update");
    if (trigger === undefined) return null;
    if (input.status === "active" && (trigger.status === "invalid" || trigger.errorCode !== null)) {
      throw new CodedError(
        "TRIGGER_CONFIGURATION_INVALID",
        trigger.errorMessage ?? "The trigger configuration is invalid and cannot be resumed.",
      );
    }
    const [updated] = await tx
      .update(automationTriggers)
      .set({
        pausedAt: input.status === "paused" ? new Date(input.updatedAt) : null,
        status: input.status,
        updatedAt: new Date(input.updatedAt),
      })
      .where(eq(automationTriggers.id, trigger.id))
      .returning({ id: automationTriggers.id });
    return updated?.id ?? null;
  });
  return triggerId === null ? null : await getTriggerById(client, triggerId);
}

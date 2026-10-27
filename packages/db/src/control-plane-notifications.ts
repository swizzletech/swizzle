import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import type { DatabaseClient } from "./client.js";
import {
  getNotificationDeliveryByDedupeKey,
  getNotificationDeliveryById,
  getNotificationRuleById,
  mapNotificationDeliveryRow,
  mapNotificationRuleRow,
  NOTIFICATION_RULE_COLUMNS,
} from "./control-plane-read-models.js";
import type {
  CreateNotificationDeliveryInput,
  CreateNotificationRuleInput,
  ListNotificationDeliveriesQuery,
  ListNotificationRulesQuery,
  NotificationDeliveryUpsertResult,
  NotificationEventType,
  StoredNotificationDelivery,
  StoredNotificationRule,
  UpdateNotificationDeliveryInput,
  UpdateNotificationRuleInput,
} from "./control-plane-types.js";
import { automationsInScope } from "./dashboard-shared.js";
import {
  automationNamed,
  automations,
  notificationDeliveries,
  notificationRules,
} from "./schema.js";

export async function createNotificationRule(
  client: DatabaseClient,
  input: CreateNotificationRuleInput,
): Promise<StoredNotificationRule> {
  const [row] = await client.db
    .insert(notificationRules)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      automationId: input.automationId,
      channel: input.channel,
      chatId: input.chatId,
      cooldownSeconds: input.cooldownSeconds,
      enabled: input.enabled ?? true,
      environment: input.environment,
      eventType: input.eventType,
      threshold: input.threshold,
      updatedAt: new Date(),
      windowSeconds: input.windowSeconds,
    })
    .returning({ id: notificationRules.id });

  if (row === undefined) {
    throw new Error("Failed to persist notification rule.");
  }

  const rule = await getNotificationRuleById(client, row.id);
  if (rule === null) {
    throw new Error(`Persisted notification rule could not be reloaded: ${row.id}`);
  }

  return rule;
}

export async function getNotificationRule(
  client: DatabaseClient,
  ruleId: string,
): Promise<StoredNotificationRule | null> {
  return await getNotificationRuleById(client, ruleId);
}

export async function listNotificationRules(
  client: DatabaseClient,
  query: ListNotificationRulesQuery,
): Promise<readonly StoredNotificationRule[]> {
  const filters = [eq(notificationRules.environment, query.environment)];
  if (query.eventType !== undefined) {
    filters.push(eq(notificationRules.eventType, query.eventType));
  }
  if (query.userId !== undefined) filters.push(eq(notificationRules.userId, query.userId));
  if (query.automation !== undefined) {
    const forAutomation = or(
      eq(notificationRules.automationId, query.automation.automationId),
      and(
        isNull(notificationRules.automationId),
        eq(notificationRules.projectId, query.automation.projectId),
      ),
    );
    if (forAutomation !== undefined) filters.push(forAutomation);
  }

  const rows = await client.db
    .select(NOTIFICATION_RULE_COLUMNS)
    .from(notificationRules)
    .leftJoin(automations, eq(notificationRules.automationId, automations.id))
    .where(and(...filters))
    .orderBy(
      sql`${automations.name} asc nulls first`,
      asc(notificationRules.eventType),
      asc(notificationRules.chatId),
    );

  return rows.map(mapNotificationRuleRow);
}

export async function updateNotificationRule(
  client: DatabaseClient,
  input: UpdateNotificationRuleInput,
): Promise<StoredNotificationRule | null> {
  const existingRule = await getNotificationRule(client, input.ruleId);
  if (existingRule === null) {
    return null;
  }

  await client.db
    .update(notificationRules)
    .set({
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      ...(input.cooldownSeconds !== undefined ? { cooldownSeconds: input.cooldownSeconds } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      updatedAt: new Date(input.updatedAt),
      ...(input.windowSeconds !== undefined ? { windowSeconds: input.windowSeconds } : {}),
    })
    .where(eq(notificationRules.id, input.ruleId));

  return await getNotificationRuleById(client, input.ruleId);
}

export async function deleteNotificationRule(
  client: DatabaseClient,
  ruleId: string,
): Promise<boolean> {
  const deleted = await client.db
    .delete(notificationRules)
    .where(eq(notificationRules.id, ruleId))
    .returning({ id: notificationRules.id });

  return deleted.length > 0;
}

export async function recordNotificationDelivery(
  client: DatabaseClient,
  input: CreateNotificationDeliveryInput,
): Promise<NotificationDeliveryUpsertResult> {
  const createdAt = new Date();
  const [row] = await client.db
    .insert(notificationDeliveries)
    .values({
      automationId: input.automationId,
      channel: input.channel,
      chatId: input.chatId,
      createdAt,
      dedupeKey: input.dedupeKey,
      deliveredAt: input.deliveredAt ? new Date(input.deliveredAt) : null,
      environment: input.environment,
      errorMessage: input.errorMessage ?? null,
      eventType: input.eventType,
      metadata: input.metadata ?? {},
      providerMessageId: input.providerMessageId ?? null,
      ruleId: input.ruleId ?? null,
      runId: input.runId ?? null,
      status: input.status,
      updatedAt: new Date(input.updatedAt ?? createdAt.toISOString()),
    })
    .onConflictDoNothing()
    .returning({ id: notificationDeliveries.id });

  const delivery = await getNotificationDeliveryByDedupeKey(client, input.dedupeKey);
  if (delivery === null) {
    throw new Error(`Notification delivery could not be reloaded: ${input.dedupeKey}`);
  }

  return {
    created: row !== undefined,
    delivery,
  } satisfies NotificationDeliveryUpsertResult;
}

export async function updateNotificationDelivery(
  client: DatabaseClient,
  input: UpdateNotificationDeliveryInput,
): Promise<StoredNotificationDelivery | null> {
  const existingDelivery = await getNotificationDeliveryById(client, input.deliveryId);
  if (existingDelivery === null) {
    return null;
  }

  await client.db
    .update(notificationDeliveries)
    .set({
      deliveredAt:
        input.deliveredAt !== undefined
          ? input.deliveredAt === null
            ? null
            : new Date(input.deliveredAt)
          : undefined,
      errorMessage: input.errorMessage ?? null,
      metadata: input.metadata ?? existingDelivery.metadata,
      providerMessageId: input.providerMessageId ?? null,
      status: input.status,
      updatedAt: new Date(input.updatedAt),
    })
    .where(eq(notificationDeliveries.id, input.deliveryId));

  return await getNotificationDeliveryById(client, input.deliveryId);
}

export async function getLatestNotificationDeliveryForRule(
  client: DatabaseClient,
  ruleId: string,
  environment: string,
  automationId: string,
  eventType: NotificationEventType,
): Promise<StoredNotificationDelivery | null> {
  const rows = await listNotificationDeliveries(client, {
    automationId,
    environment,
    eventType,
    limit: 1,
    ruleId,
  });
  return rows[0] ?? null;
}

export async function listNotificationDeliveries(
  client: DatabaseClient,
  query: ListNotificationDeliveriesQuery,
): Promise<readonly StoredNotificationDelivery[]> {
  const { environment } = query;
  const filters = [eq(notificationDeliveries.environment, environment)];
  if (query.ruleId !== undefined) {
    filters.push(eq(notificationDeliveries.ruleId, query.ruleId));
  }
  if (query.ruleOwner !== undefined) {
    filters.push(
      inArray(
        notificationDeliveries.ruleId,
        client.db
          .select({ id: notificationRules.id })
          .from(notificationRules)
          .where(eq(notificationRules.userId, query.ruleOwner.userId)),
      ),
    );
    const readable = automationsInScope(query.ruleOwner.scope);
    if (readable !== undefined) filters.push(readable);
  }
  if (query.automationId !== undefined) {
    filters.push(eq(notificationDeliveries.automationId, query.automationId));
  }
  if (query.eventType !== undefined) {
    filters.push(eq(notificationDeliveries.eventType, query.eventType));
  }
  if (query.automationSlug !== undefined && query.automationSlug !== "") {
    filters.push(automationNamed(query.automationSlug));
  }
  if (query.status !== undefined) {
    filters.push(eq(notificationDeliveries.status, query.status));
  }
  if (query.createdSince !== undefined) {
    filters.push(gte(notificationDeliveries.createdAt, new Date(query.createdSince)));
  }

  const rows = await client.db
    .select({
      automationId: automations.id,
      automationName: automations.name,
      automationSlug: automations.slug,
      channel: notificationDeliveries.channel,
      chatId: notificationDeliveries.chatId,
      createdAt: notificationDeliveries.createdAt,
      dedupeKey: notificationDeliveries.dedupeKey,
      deliveredAt: notificationDeliveries.deliveredAt,
      deliveryId: notificationDeliveries.id,
      environment: notificationDeliveries.environment,
      errorMessage: notificationDeliveries.errorMessage,
      eventType: notificationDeliveries.eventType,
      metadata: notificationDeliveries.metadata,
      providerMessageId: notificationDeliveries.providerMessageId,
      ruleId: notificationDeliveries.ruleId,
      runId: notificationDeliveries.runId,
      status: notificationDeliveries.status,
      updatedAt: notificationDeliveries.updatedAt,
    })
    .from(notificationDeliveries)
    .innerJoin(automations, eq(notificationDeliveries.automationId, automations.id))
    .where(and(...filters))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(normalizeLimit(query.limit, 20, 200));

  return rows.map(mapNotificationDeliveryRow);
}

function normalizeLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(limit), max));
}

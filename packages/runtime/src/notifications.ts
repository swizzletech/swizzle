import {
  type ControlPlaneStore,
  DEFAULT_PROJECT_ID,
  type NotificationDeliveryEventType,
  type NotificationEventType,
  type StoredNotificationDelivery,
  type StoredNotificationRule,
  type StoredRun,
} from "@swizzle/db";

const TELEGRAM_BOT_TOKEN_SECRET = "SWIZZLE_TELEGRAM_BOT_TOKEN";
const MAX_TELEGRAM_TEXT_CHARS = 4_096;

interface TelegramMessageInput {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
}

interface TelegramMessageResult {
  readonly providerMessageId: string | null;
}

type TelegramMessageSender = (input: TelegramMessageInput) => Promise<TelegramMessageResult>;

export interface ProcessRunNotificationsInput {
  readonly now?: Date;
  readonly run: StoredRun;
  readonly store: ControlPlaneStore;
}

interface NotificationSignal {
  readonly cooldownActive: boolean;
  readonly failureCount: number;
  readonly metadata: Record<string, unknown>;
  readonly rule: StoredNotificationRule;
}

/**
 * Commits a delivery intent for each rule a dead-lettered run fires. Nothing is sent here: the
 * API's dispatch loop sends pending intents with `deliverPendingNotification`, outside any lease.
 */
export async function processRunNotifications(
  input: ProcessRunNotificationsInput,
): Promise<readonly StoredNotificationDelivery[]> {
  if (input.run.status !== "dead-lettered") {
    return [];
  }

  const observedAt = input.now ?? new Date();
  const rules = await input.store.listNotificationRules({
    automation: { automationId: input.run.automationId, projectId: input.run.projectId },
    environment: input.run.environment,
  });
  const deliveries: StoredNotificationDelivery[] = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    const signal = await evaluateRule({
      now: observedAt,
      rule,
      run: input.run,
      store: input.store,
    });
    if (signal === null) {
      continue;
    }

    deliveries.push(
      await commitDelivery({
        automationId: input.run.automationId,
        cooldownActive: signal.cooldownActive,
        projectId: input.run.projectId,
        dedupeKey: buildDedupeKey(rule, input.run),
        environment: input.run.environment,
        eventType: rule.eventType,
        metadata: signal.metadata,
        now: observedAt,
        rule,
        runId: input.run.runId,
        store: input.store,
        text: formatTelegramMessage({
          eventType: rule.eventType,
          failureCount: signal.failureCount,
          rule,
          run: input.run,
        }),
      }),
    );
  }

  return deliveries;
}

/**
 * An alert about an automation's outside API: its check started failing, or the API announced
 * its retirement. It goes once to every enabled rule of the automation, whatever run event the
 * rule names, and skips the cooldown: `key` names the event, so a second send is a no-op.
 */
export interface ApiAlert {
  readonly automation: {
    readonly automationId: string;
    readonly automationName: string;
    readonly automationSlug: string;
    readonly projectId: string;
  };
  readonly environment: string;
  readonly eventType: "api-check" | "api-sunset";
  readonly key: string;
  /** The message after its header and the automation and environment lines. */
  readonly lines: readonly string[];
  readonly metadata: Record<string, unknown>;
}

/** Commits the alert's delivery intents; the dispatch loop sends them, as for run notifications. */
export async function sendApiAlert(input: {
  readonly alert: ApiAlert;
  readonly now?: Date;
  readonly store: ControlPlaneStore;
}): Promise<readonly StoredNotificationDelivery[]> {
  const { alert } = input;
  const rules = await input.store.listNotificationRules({
    automation: {
      automationId: alert.automation.automationId,
      projectId: alert.automation.projectId,
    },
    environment: alert.environment,
  });
  const header = alert.eventType === "api-check" ? "⚠️ Swizzle API check" : "⚠️ Swizzle API sunset";
  const text = boundTelegramText(
    [
      header,
      `automation: ${alert.automation.automationName}`,
      `environment: ${alert.environment}`,
      ...alert.lines,
    ].join("\n"),
  );
  const deliveries: StoredNotificationDelivery[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    deliveries.push(
      await commitDelivery({
        automationId: alert.automation.automationId,
        cooldownActive: false,
        projectId: alert.automation.projectId,
        dedupeKey: `${alert.eventType}:${rule.ruleId}:${alert.key}`,
        environment: alert.environment,
        eventType: alert.eventType,
        metadata: alert.metadata,
        now: input.now ?? new Date(),
        rule,
        runId: null,
        store: input.store,
        text,
      }),
    );
  }
  return deliveries;
}

/**
 * Records a pending delivery under `dedupeKey`, once; a known key records nothing new. A
 * rule's person must still be able to read the automation's runs in this environment, or the
 * delivery is skipped: a revoked grant, a suspension or a removal stops the next message. That
 * check comes first, so the record names the revoked access even inside the cooldown, and before
 * the key is claimed, so a failed check leaves nothing behind that would stop a retry.
 */
async function commitDelivery(input: {
  readonly automationId: string;
  readonly cooldownActive: boolean;
  readonly projectId: string;
  readonly dedupeKey: string;
  readonly environment: string;
  readonly eventType: NotificationDeliveryEventType;
  readonly metadata: Record<string, unknown>;
  readonly now: Date;
  readonly rule: StoredNotificationRule;
  readonly runId: string | null;
  readonly store: ControlPlaneStore;
  readonly text: string;
}): Promise<StoredNotificationDelivery> {
  const updatedAt = input.now.toISOString();
  const record = (
    status: "pending" | "skipped",
    metadata: Record<string, unknown>,
    errorMessage?: string,
  ) =>
    input.store.recordNotificationDelivery({
      automationId: input.automationId,
      channel: input.rule.channel,
      chatId: input.rule.chatId,
      dedupeKey: input.dedupeKey,
      environment: input.environment,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      eventType: input.eventType,
      metadata,
      ruleId: input.rule.ruleId,
      runId: input.runId,
      status,
      updatedAt,
    });

  const mayRead = await input.store.personMayRead(input.rule.userId, {
    automationId: input.automationId,
    environment: input.environment,
    projectId: input.projectId,
  });
  if (!mayRead) {
    const skipped = await record(
      "skipped",
      { ...input.metadata, reason: "access-revoked" },
      "The rule's person may no longer read this automation's runs.",
    );
    return skipped.delivery;
  }
  if (input.cooldownActive) {
    return (await record("skipped", { ...input.metadata, reason: "cooldown" })).delivery;
  }
  const pending = await record("pending", {
    ...input.metadata,
    telegramText: input.text,
    notificationProjectId: input.projectId,
  });
  return pending.delivery;
}

/** Sends a previously committed intent. No execution ownership lock is held here. */
export async function deliverPendingNotification(
  delivery: StoredNotificationDelivery,
  store: ControlPlaneStore,
  sender: TelegramMessageSender = sendTelegramMessage,
): Promise<StoredNotificationDelivery> {
  const updatedAt = new Date().toISOString();
  const rule = delivery.ruleId === null ? null : await store.getNotificationRule(delivery.ruleId);
  const projectId = delivery.metadata.notificationProjectId;
  if (
    rule === null ||
    !rule.enabled ||
    typeof projectId !== "string" ||
    !(await store.personMayRead(rule.userId, {
      automationId: delivery.automationId,
      projectId,
      environment: delivery.environment,
    }))
  ) {
    return (
      (await store.updateNotificationDelivery({
        deliveryId: delivery.deliveryId,
        errorMessage:
          "The rule's person may no longer read this automation's runs or the rule was removed or disabled.",
        metadata: { ...delivery.metadata, reason: "access-revoked" },
        status: "skipped",
        updatedAt,
      })) ?? delivery
    );
  }
  const token = await resolveTelegramBotToken(store, delivery.environment);
  if (token === null)
    return (
      (await store.updateNotificationDelivery({
        deliveryId: delivery.deliveryId,
        errorMessage: `Missing platform secret ${TELEGRAM_BOT_TOKEN_SECRET}.`,
        metadata: { ...delivery.metadata, reason: "missing-telegram-bot-token" },
        status: "skipped",
        updatedAt,
      })) ?? delivery
    );
  try {
    const text = delivery.metadata.telegramText;
    if (typeof text !== "string") throw new Error("Notification intent has no message.");
    const result = await sender({ botToken: token, chatId: delivery.chatId, text });
    return (
      (await store.updateNotificationDelivery({
        deliveryId: delivery.deliveryId,
        deliveredAt: updatedAt,
        metadata: delivery.metadata,
        providerMessageId: result.providerMessageId,
        status: "sent",
        updatedAt,
      })) ?? delivery
    );
  } catch (error) {
    return (
      (await store.updateNotificationDelivery({
        deliveryId: delivery.deliveryId,
        errorMessage: error instanceof Error ? error.message : String(error),
        metadata: delivery.metadata,
        status: "failed",
        updatedAt,
      })) ?? delivery
    );
  }
}

async function evaluateRule(input: {
  readonly now: Date;
  readonly rule: StoredNotificationRule;
  readonly run: StoredRun;
  readonly store: ControlPlaneStore;
}): Promise<NotificationSignal | null> {
  const failureCount =
    input.rule.eventType === "repeated-failures"
      ? await input.store.countDeadLetteredRunsSince(
          input.run.automationId,
          input.run.environment,
          new Date(input.now.getTime() - input.rule.windowSeconds * 1000).toISOString(),
        )
      : 1;

  if (input.rule.eventType === "repeated-failures" && failureCount < input.rule.threshold) {
    return null;
  }

  const latestDelivery = await input.store.getLatestNotificationDeliveryForRule(
    input.rule.ruleId,
    input.rule.environment,
    input.run.automationId,
    input.rule.eventType,
  );
  const cooldownActive =
    latestDelivery !== null &&
    Date.parse(latestDelivery.createdAt) + input.rule.cooldownSeconds * 1000 > input.now.getTime();

  return {
    cooldownActive,
    failureCount,
    metadata: {
      attemptsMade: input.run.attemptsMade,
      attemptsMax: input.run.attemptsMax,
      deadLetterReason: input.run.deadLetterReason,
      errorCode: input.run.errorCode,
      errorMessage: input.run.errorMessage,
      failureCount,
      queuedAt: input.run.queuedAt,
      runId: input.run.runId,
      status: input.run.status,
    },
    rule: input.rule,
  };
}

async function resolveTelegramBotToken(
  store: ControlPlaneStore,
  environment: string,
): Promise<string | null> {
  // Notifications are the instance's, so their bot token is a secret of the default project.
  const secret = await store.findCredential("secret", TELEGRAM_BOT_TOKEN_SECRET, {
    environment,
    projectId: DEFAULT_PROJECT_ID,
  });
  if (secret === null) return null;
  const [resolved] = await store.resolveSecrets([secret.id]);
  return resolved?.value ?? null;
}

function buildDedupeKey(rule: StoredNotificationRule, run: StoredRun): string {
  return `${rule.eventType}:${rule.ruleId}:${run.runId}`;
}

function formatTelegramMessage(input: {
  readonly eventType: NotificationEventType;
  readonly failureCount: number;
  readonly rule: StoredNotificationRule;
  readonly run: StoredRun;
}): string {
  const header =
    input.eventType === "repeated-failures"
      ? "🚨 Swizzle repeated failures"
      : "🚨 Swizzle dead letter";
  const lines = [
    header,
    `automation: ${input.run.automationName}`,
    `environment: ${input.run.environment}`,
    `run: ${input.run.runId}`,
    `event: ${input.eventType}`,
    `attempts: ${input.run.attemptsMade} / ${input.run.attemptsMax}`,
  ];

  if (input.eventType === "repeated-failures") {
    lines.push(
      `dead-lettered runs in last ${Math.max(1, Math.round(input.rule.windowSeconds / 60))}m: ${input.failureCount}`,
      `threshold: ${input.rule.threshold}`,
    );
  }

  if (input.run.errorCode) {
    lines.push(`error code: ${input.run.errorCode}`);
  }
  if (input.run.errorMessage) {
    lines.push(`error: ${input.run.errorMessage}`);
  }
  if (input.run.deadLetterReason) {
    lines.push(`dead-letter reason: ${input.run.deadLetterReason}`);
  }

  lines.push(`queued: ${input.run.queuedAt}`);
  return boundTelegramText(lines.join("\n"));
}

function boundTelegramText(text: string): string {
  return text.slice(0, MAX_TELEGRAM_TEXT_CHARS).replace(/[\uD800-\uDBFF]$/u, "");
}

async function sendTelegramMessage(input: TelegramMessageInput): Promise<TelegramMessageResult> {
  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`, {
    body: JSON.stringify({
      chat_id: input.chatId,
      disable_web_page_preview: true,
      text: input.text,
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });

  const body = await safeJson(response);
  if (!response.ok || !isTelegramOk(body)) {
    const description =
      typeof body === "object" && body !== null && "description" in body
        ? String(body.description)
        : response.statusText;
    throw new Error(`Telegram delivery failed: ${response.status} ${description}`.trim());
  }

  const providerMessageId =
    typeof body.result === "object" &&
    body.result !== null &&
    "message_id" in body.result &&
    body.result.message_id !== undefined
      ? String(body.result.message_id)
      : null;

  return { providerMessageId };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isTelegramOk(body: unknown): body is { ok: true; result?: { message_id?: number } } {
  return typeof body === "object" && body !== null && "ok" in body && body.ok === true;
}

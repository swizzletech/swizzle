// Settings › Notifications (`/settings/notifications`): the default Telegram rule, advanced rules
// and the delivery history.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ActionError } from "../../components/actions";
import { Chip, ErrorNote, Skeleton, useNow } from "../../components/ui";
import type { NotificationRule } from "../../lib/api";
import { useDashboardClient } from "../../lib/dashboard-client";
import { refreshAll, useAutomations } from "../../lib/queries";
import { ageInWords, durationInWords } from "../../lib/words/time";
import { Section } from "./section";

const BOT_TOKEN_SECRET = "SWIZZLE_TELEGRAM_BOT_TOKEN";

export function Notifications({ operator }: { readonly operator: boolean }) {
  const { api, queryScope } = useDashboardClient();
  const rules = useQuery({
    queryFn: async () => (await api.listNotificationRules()).rules,
    queryKey: ["notification-rules", ...queryScope],
  });
  const secrets = useQuery({
    queryFn: async () => (await api.listSecrets()).secrets,
    queryKey: ["secrets", ...queryScope],
  });
  const defaultRule = rules.data?.find(
    (rule) => rule.automationId === null && rule.eventType === "dead-lettered",
  );
  const botTokenMissing =
    secrets.data !== undefined && !secrets.data.some((secret) => secret.name === BOT_TOKEN_SECRET);

  return (
    <Section
      intro="Swizzle messages you on Telegram when runs fail, so you need not watch this page."
      title="Notifications"
    >
      {botTokenMissing ? (
        <p className="notice mb-3">
          Telegram needs a bot token first. Store it as the secret{" "}
          <span className="mono">{BOT_TOKEN_SECRET}</span>{" "}
          <Link className="linkish" search={{ secret: BOT_TOKEN_SECRET }} to="/credentials">
            on Credentials
          </Link>
          .
        </p>
      ) : null}
      {rules.isError ? (
        <ErrorNote error={rules.error} title="The notification rules could not be loaded." />
      ) : rules.data === undefined ? (
        <div className="card">
          {/* As tall as the loaded card, so Account and Instance stay put when it arrives. */}
          <Skeleton label="Loading notification rules" lines={8} />
        </div>
      ) : (
        <div className="card rows overflow-hidden">
          {/* Keyed by rule, so the chat id field follows a default rule created in Advanced. */}
          <DefaultRule key={defaultRule?.ruleId ?? "none"} rule={defaultRule} />
          <details className="group">
            <summary className="setting cursor-pointer list-none">
              <span>
                <b>Advanced</b>
                <span className="t-meta">
                  {" "}
                  · rules for single automations and repeated failures
                </span>
              </span>
              <span className="t-faint group-open:rotate-90">›</span>
            </summary>
            <AdvancedRules rules={rules.data.filter((rule) => rule !== defaultRule)} />
          </details>
          <details className="group">
            <summary className="setting cursor-pointer list-none">
              <span>
                <b>Delivery history</b>
                <span className="t-meta">
                  {" "}
                  · what was sent, skipped or failed
                  {operator ? " for every rule" : " for your rules"}
                </span>
              </span>
              <span className="t-faint group-open:rotate-90">›</span>
            </summary>
            <Deliveries />
          </details>
        </div>
      )}
    </Section>
  );
}

/** The switch most owners need: one rule for every automation, when a run finally fails. */
function DefaultRule({ rule }: { readonly rule: NotificationRule | undefined }) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [chatId, setChatId] = useState(rule?.chatId ?? "");
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      rule === undefined
        ? api.createNotificationRule({ chatId: chatId.trim(), enabled, eventType: "dead-lettered" })
        : api.updateNotificationRule(rule.ruleId, { chatId: chatId.trim(), enabled }),
    onSuccess: () => refreshAll(queryClient),
  });
  const enabled = rule?.enabled === true;
  return (
    <div className="setting" data-testid="default-notification">
      <div className="min-w-0">
        <b>Message me on Telegram when a run finally fails</b>
        <div className="t-meta">For every automation, after its last retry.</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            aria-label="Telegram chat id"
            className="field w-56"
            onChange={(event) => setChatId(event.target.value)}
            placeholder="Telegram chat id"
            value={chatId}
          />
          {rule !== undefined && chatId.trim() !== rule.chatId && chatId.trim() !== "" ? (
            <button
              className="btn quiet small"
              disabled={save.isPending}
              onClick={() => save.mutate(enabled)}
              type="button"
            >
              Save chat id
            </button>
          ) : null}
          {save.isError ? <ActionError error={save.error} /> : null}
        </div>
      </div>
      <input
        aria-label="Message me on Telegram when a run finally fails"
        checked={enabled}
        className="switch"
        disabled={save.isPending || chatId.trim() === ""}
        onChange={(event) => save.mutate(event.target.checked)}
        title={chatId.trim() === "" ? "Enter the chat id first." : undefined}
        type="checkbox"
      />
    </div>
  );
}

/** "When 3 runs fail within 60 min", "When a run finally fails", with the cooldown. */
function ruleInWords(rule: NotificationRule): string {
  const when =
    rule.eventType === "dead-lettered"
      ? "When a run finally fails"
      : `When ${rule.threshold} runs fail within ${durationInWords(rule.windowSeconds * 1000)}`;
  return `${when}, at most every ${durationInWords(rule.cooldownSeconds * 1000)}`;
}

function AdvancedRules({ rules }: { readonly rules: readonly NotificationRule[] }) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const automations = useAutomations().data ?? [];
  const [automation, setAutomation] = useState("");
  const [eventType, setEventType] = useState<NotificationRule["eventType"]>("repeated-failures");
  const [threshold, setThreshold] = useState("3");
  const [windowMinutes, setWindowMinutes] = useState("60");
  const [cooldownMinutes, setCooldownMinutes] = useState("15");
  const [chatId, setChatId] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api.createNotificationRule({
        ...(automation === "" ? {} : { automationName: automation }),
        chatId: chatId.trim(),
        cooldownSeconds: Number(cooldownMinutes) * 60,
        eventType,
        ...(eventType === "repeated-failures"
          ? { threshold: Number(threshold), windowSeconds: Number(windowMinutes) * 60 }
          : {}),
      }),
    onSuccess: async () => {
      setChatId("");
      await refreshAll(queryClient);
    },
  });
  const toggle = useMutation({
    mutationFn: (rule: NotificationRule) =>
      api.updateNotificationRule(rule.ruleId, { enabled: !rule.enabled }),
    onSuccess: () => refreshAll(queryClient),
  });
  const remove = useMutation({
    mutationFn: (ruleId: string) => api.deleteNotificationRule(ruleId),
    onSuccess: () => refreshAll(queryClient),
  });
  const error = create.error ?? toggle.error ?? remove.error;

  return (
    <div className="rows border-t border-line">
      {rules.map((rule) => (
        <div className="setting" data-testid="notification-rule" key={rule.ruleId}>
          <div className="min-w-0">
            <b>{rule.automationName ?? "Every automation"}</b>
            {rule.enabled ? null : (
              <>
                {" "}
                <Chip tone="idle">Off</Chip>
              </>
            )}
            <div className="t-meta">
              {ruleInWords(rule)} · chat <span className="mono">{rule.chatId}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn quiet small"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(rule)}
              type="button"
            >
              {rule.enabled ? "Turn off" : "Turn on"}
            </button>
            <button
              className="btn danger small"
              disabled={remove.isPending}
              onClick={() => remove.mutate(rule.ruleId)}
              type="button"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
      <form
        className="grid gap-3 bg-surface-2 px-[18px] py-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (chatId.trim() !== "" && !create.isPending) create.mutate();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="form-label">
            Automation
            <select
              className="field"
              onChange={(event) => setAutomation(event.target.value)}
              value={automation}
            >
              <option value="">Every automation</option>
              {automations.map((item) => (
                <option key={item.automationSlug} value={item.automationName}>
                  {item.automationName}
                </option>
              ))}
            </select>
          </label>
          <label className="form-label">
            Message when
            <select
              className="field"
              onChange={(event) =>
                setEventType(event.target.value as NotificationRule["eventType"])
              }
              value={eventType}
            >
              <option value="repeated-failures">several runs fail</option>
              <option value="dead-lettered">a run finally fails</option>
            </select>
          </label>
          {eventType === "repeated-failures" ? (
            <>
              <label className="form-label">
                Runs
                <input
                  className="field w-20"
                  min={1}
                  onChange={(event) => setThreshold(event.target.value)}
                  type="number"
                  value={threshold}
                />
              </label>
              <label className="form-label">
                Within minutes
                <input
                  className="field w-24"
                  min={1}
                  onChange={(event) => setWindowMinutes(event.target.value)}
                  type="number"
                  value={windowMinutes}
                />
              </label>
            </>
          ) : null}
          <label className="form-label">
            At most every minutes
            <input
              className="field w-24"
              min={0}
              onChange={(event) => setCooldownMinutes(event.target.value)}
              type="number"
              value={cooldownMinutes}
            />
          </label>
          <label className="form-label">
            Chat id
            <input
              className="field w-40"
              onChange={(event) => setChatId(event.target.value)}
              value={chatId}
            />
          </label>
          <button className="btn" disabled={chatId.trim() === "" || create.isPending} type="submit">
            Add rule
          </button>
        </div>
        {error ? <ActionError error={error} /> : null}
      </form>
    </div>
  );
}

const DELIVERY_TONE = { failed: "fail", pending: "run", sent: "ok", skipped: "idle" } as const;

function Deliveries() {
  const { api, queryScope } = useDashboardClient();
  const now = useNow();
  const deliveries = useQuery({
    queryFn: async () => (await api.listNotificationDeliveries({ limit: 20 })).deliveries,
    queryKey: ["notification-deliveries", ...queryScope],
  });
  if (deliveries.isError) {
    return (
      <div className="p-4">
        <ErrorNote error={deliveries.error} title="The delivery history could not be loaded." />
      </div>
    );
  }
  if (deliveries.data === undefined) return <Skeleton label="Loading deliveries" lines={3} />;
  if (deliveries.data.length === 0) {
    return <p className="t-meta border-t border-line px-[18px] py-3.5">Nothing was sent yet.</p>;
  }
  return (
    <div className="rows border-t border-line">
      {deliveries.data.map((delivery) => (
        <div className="setting" key={delivery.deliveryId}>
          <div className="min-w-0">
            <b>{delivery.automationName}</b>{" "}
            <span className="t-meta">
              {delivery.eventType === "dead-lettered" ? "run finally failed" : "repeated failures"}
            </span>
            {delivery.errorMessage === null ? null : (
              <div className="t-faint">{delivery.errorMessage}</div>
            )}
          </div>
          <span className="flex items-center gap-3">
            <Chip tone={DELIVERY_TONE[delivery.status]}>{delivery.status}</Chip>
            <span className="t-faint">{ageInWords(delivery.createdAt, now)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

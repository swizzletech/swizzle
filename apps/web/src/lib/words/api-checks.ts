// API checks and sunset notices in words, and what "Hand to agent" copies for them. Hand-off texts
// name times in UTC so they read the same everywhere.

import { formatIntervalMs } from "@swizzle/config/browser";
import type { ApiCheck, AttentionItem } from "../api";
import type { Tone } from "./health";
import { durationInWords } from "./time";

type ApiCheckItem = Extract<AttentionItem, { readonly kind: "api-check" }>;

type ApiSunsetItem = Extract<AttentionItem, { readonly kind: "api-sunset" }>;

type ApiUntestedItem = Extract<AttentionItem, { readonly kind: "api-untested" }>;

/** A run that failed with `UPSTREAM_CONTRACT_CHANGED` failed because its API changed. */
export const UPSTREAM_CONTRACT_CHANGED = "UPSTREAM_CONTRACT_CHANGED";

/** "crm-export's check of api.hubapi.com fails", "crm-export's API check could not decide 3 times in a row". */
export function apiCheckInWords(item: ApiCheckItem): string {
  const name = item.automation.automationName;
  if (item.check.status === "credentials") return `${name}'s API check credentials failed`;
  if (item.check.status === "error") {
    return `${name}'s API check could not decide ${item.check.consecutiveFailures} times in a row`;
  }
  const host = item.change?.api;
  return host ? `${name}'s check of ${host} fails` : `${name}'s API check fails`;
}

/**
 * "its runs fail too", or "its runs still succeed" once a run succeeded after the check started
 * failing; null while no run finished since, because an older success says nothing yet.
 */
export function apiCheckRunsInWords(item: ApiCheckItem): string | null {
  const run = item.latestRun;
  if (run === null) return null;
  if (run.status !== "succeeded") return "its runs fail too";
  return ranSinceFailing(item) ? "its runs still succeed" : null;
}

/** "amount: expected number, got string", or null when the check output names no field. */
export function apiChangeInWords(change: ApiCheckItem["change"]): string | null {
  if (change === null || change.field === null) return null;
  const expected = change.expected === null ? null : `expected ${change.expected}`;
  const got = change.got === null ? null : `got ${change.got}`;
  const detail = [expected, got].filter((part) => part !== null).join(", ");
  return detail === "" ? change.field : `${change.field}: ${detail}`;
}

/** "api.example-bank.de retires on 2026-12-31", or "deprecated since 2026-10-01" without a sunset. */
export function apiSunsetInWords(contact: ApiSunsetItem["contact"]): string {
  return contact.sunsetAt === null
    ? `${contact.host}, deprecated since ${utcDate(contact.deprecatedAt ?? "")}`
    : `${contact.host} retires on ${utcDate(contact.sunsetAt)}`;
}

/** "API check active", "API check passive", "API check off: Paid per call". */
export function apiCheckLevelInWords(apiCheck: ApiCheck | null): string {
  if (apiCheck === null) return "no API check";
  return apiCheck.mode === "off"
    ? `API check off: ${apiCheck.reason}`
    : `API check ${apiCheck.mode}`;
}

/** "has not reached api.hubapi.com for 34 days", or since its deploy when no call was seen. */
export function apiUntestedInWords(item: ApiUntestedItem, now: Date): string {
  const days = durationInWords(Math.max(0, now.getTime() - Date.parse(item.since)));
  return item.host === null
    ? `has not reached an API in the ${days} since its deploy`
    : `has not reached ${item.host} for ${days}`;
}

type CheckStatus = NonNullable<Extract<ApiCheck, { readonly mode: "active" }>["record"]>["status"];

/** An active check's latest result as the About tab's chip shows it. */
export const CHECK_STATUS: Record<CheckStatus, { readonly label: string; readonly tone: Tone }> = {
  credentials: { label: "Credentials failed", tone: "warn" },
  drift: { label: "Drift", tone: "warn" },
  error: { label: "Undecided", tone: "warn" },
  green: { label: "Green", tone: "ok" },
  pending: { label: "Not run yet", tone: "idle" },
};

/**
 * What "Hand to agent" copies for an API check under Needs you: since when checks fail and how the
 * latest one ended, whether the runs feel it yet, the latest and the last green output side by side,
 * and the commands to act.
 */
export function apiCheckHandoff(item: ApiCheckItem): string {
  const { check } = item;
  const name = item.automation.automationName;
  const words = checkHandoffWords(check);
  const failures =
    check.consecutiveFailures === 1 ? "1 check" : `${check.consecutiveFailures} checks in a row`;
  const lines = [
    `${name}'s API check has failed since ` +
      `${utcTime(check.failingSince ?? check.lastCheckedAt ?? "")} (${failures}); ` +
      `the latest check, ${utcTime(check.lastCheckedAt ?? "")}, ${words.outcome}. ${runsLine(item)}`,
    `The check is ${check.entrypoint} in deployment ${check.deploymentId.slice(0, 8)}, every ` +
      `${formatIntervalMs(check.everyMs)} and after each deploy` +
      `${item.change?.api ? `, against ${item.change.api}` : ""}.`,
    `Latest check, ${utcTime(check.lastCheckedAt ?? "")}, exit ${check.lastExitCode ?? "none"}:`,
    check.lastOutput ?? "(no output on stdout)",
  ];
  if (check.lastStderrTail) lines.push("Its stderr ended with:", check.lastStderrTail);
  lines.push(
    ...(check.lastGreenOutput === null || check.lastGreenAt === null
      ? ["No check was green yet."]
      : [`Last green check, ${utcTime(check.lastGreenAt)}, exit 0:`, check.lastGreenOutput]),
    words.fix,
    "Reproduce with `swizzle run --check .`, run the automation locally with `swizzle run .` and redeploy with `swizzle apply .`.",
  );
  return lines.join("\n");
}

function checkHandoffWords(check: Pick<ApiCheckItem["check"], "status" | "entrypoint">) {
  if (check.status === "credentials")
    return {
      outcome: "failed on credentials",
      fix: "Fix the check's credentials or connection, then rerun the check.",
    };
  if (check.status === "drift")
    return {
      outcome: "found drift",
      fix: `Compare the two outputs, then update the response parsing that the automation and ${check.entrypoint} share to the new shape.`,
    };
  return {
    outcome: "could not decide",
    fix: "Find out from the output and stderr why the check could not decide, such as an outage, a timeout or an expired key.",
  };
}

function runsLine(item: ApiCheckItem): string {
  const run = item.latestRun;
  if (run === null) return "None of its recent runs has finished.";
  if (run.status !== "succeeded") {
    return `Its runs fail too; the last run ended ${run.status} at ${utcTime(run.queuedAt)}.`;
  }
  return ranSinceFailing(item)
    ? `Its last run, queued at ${utcTime(run.queuedAt)} after the check started failing, succeeded.`
    : `Its last run succeeded at ${utcTime(run.queuedAt)}, before the check started failing; no run finished since.`;
}

/** Whether the latest finished run was queued after the check started failing. */
function ranSinceFailing(item: ApiCheckItem): boolean {
  const since = item.check.failingSince;
  return item.latestRun !== null && since !== null && item.latestRun.queuedAt > since;
}

/** What "Hand to agent" copies for a sunset notice: the dates, where the headers came, the notice and the level. */
export function apiSunsetHandoff(item: ApiSunsetItem, now: Date): string {
  const { contact } = item;
  const name = item.automation.automationName;
  const dates = [
    contact.deprecatedAt === null ? null : `deprecated since ${utcDate(contact.deprecatedAt)}`,
    contact.sunsetAt === null
      ? null
      : `sunset on ${utcDate(contact.sunsetAt)} (${sunsetDistance(contact.sunsetAt, now)})`,
  ].filter((part) => part !== null);
  const runs =
    contact.noticeRuns === 1 ? "1 run or check" : `${contact.noticeRuns} runs and checks`;
  const lines = [
    `${name} calls ${contact.host}, which announced its retirement: ${dates.join(", ")}. ` +
      `The headers came in ${runs}, the latest at ${utcTime(contact.noticeSeenAt ?? contact.lastContactAt)}` +
      `${contact.noticePath === null ? "" : `, on ${contact.noticePath}`}.`,
  ];
  if (contact.noticeUrl !== null) lines.push(`The provider's notice: ${contact.noticeUrl}`);
  if (item.apiCheck?.mode === "off") {
    lines.push(`API checks are off for ${name}: "${item.apiCheck.reason}"`);
  }
  lines.push(
    `Read the notice, move the calls to the successor API${
      contact.sunsetAt === null ? "" : ` before ${utcDate(contact.sunsetAt)}`
    }, run the automation locally with \`swizzle run .\`, and redeploy with \`swizzle apply .\`.`,
  );
  return lines.join("\n");
}

function sunsetDistance(sunsetAt: string, now: Date): string {
  const ms = Date.parse(sunsetAt) - now.getTime();
  return ms < 0 ? `${durationInWords(-ms)} ago` : `in ${durationInWords(ms)}`;
}

/** "2026-10-24 08:00 UTC"; Hand to agent texts name times in UTC so they read the same everywhere. */
function utcTime(iso: string): string {
  return iso === "" ? "an unknown time" : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

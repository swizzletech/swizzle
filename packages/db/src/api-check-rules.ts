import { parseIntervalToMs } from "@swizzle/config";
import { CronExpressionParser } from "cron-parser";
import type {
  ApiContactObservation,
  StoredApiContact,
  StoredAutomationCheck,
  StoredDeployment,
} from "./control-plane-types.js";

export function deploymentCheckInput(
  deployment: Pick<StoredDeployment, "config">,
): { readonly entrypoint: string; readonly everyMs: number } | null {
  const apiCheck = deployment.config.api_check;
  if (apiCheck?.mode !== "active") return null;
  return { entrypoint: apiCheck.entrypoint, everyMs: parseIntervalToMs(apiCheck.every) };
}

export function untestedThresholdMs(
  untestedAfter: string,
  trigger: { readonly cronIntervalMs: number | null; readonly cronSchedule: string | null } | null,
  from: Date,
): number {
  const configured = parseIntervalToMs(untestedAfter);
  const intervalMs =
    trigger?.cronIntervalMs ??
    (trigger?.cronSchedule ? cronScheduleIntervalMs(trigger.cronSchedule, from) : undefined);
  return Math.max(configured, 2 * (intervalMs ?? 0));
}

function cronScheduleIntervalMs(schedule: string, from: Date): number | undefined {
  try {
    const [first, second] = CronExpressionParser.parse(schedule, {
      currentDate: from,
      tz: "UTC",
    }).take(2);
    return first !== undefined && second !== undefined
      ? second.getTime() - first.getTime()
      : undefined;
  } catch {
    return undefined;
  }
}

export function mergeApiContact(
  previous: StoredApiContact | null,
  observation: ApiContactObservation,
  key: { readonly automationId: string; readonly environment: string },
): { readonly contact: StoredApiContact; readonly newNotice: boolean } {
  const later = previous === null || observation.lastContactAt >= previous.lastContactAt;
  const seenAt = previous?.noticeSeenAt ?? null;
  const notice =
    observation.notice !== null && (seenAt === null || observation.lastContactAt >= seenAt)
      ? observation.notice
      : null;
  const contact: StoredApiContact = {
    automationId: key.automationId,
    deprecatedAt: previous?.deprecatedAt ?? notice?.deprecatedAt ?? null,
    environment: key.environment,
    host: observation.host,
    lastContactAt: later ? observation.lastContactAt : (previous?.lastContactAt ?? ""),
    lastOkAt: latest(previous?.lastOkAt ?? null, observation.lastOkAt),
    lastStatus: later ? observation.lastStatus : (previous?.lastStatus ?? observation.lastStatus),
    noticePath: notice?.path ?? previous?.noticePath ?? null,
    noticeRuns: (previous?.noticeRuns ?? 0) + (observation.notice === null ? 0 : 1),
    noticeSeenAt: notice === null ? seenAt : observation.lastContactAt,
    noticeUrl: notice?.url ?? previous?.noticeUrl ?? null,
    sunsetAt: notice?.sunsetAt ?? previous?.sunsetAt ?? null,
  };
  const newNotice =
    notice !== null &&
    (previous === null ||
      previous.noticeSeenAt === null ||
      contact.sunsetAt !== previous.sunsetAt ||
      (previous.deprecatedAt === null && contact.deprecatedAt !== null));
  return { contact, newNotice };
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

export function checkNeedsAttention(
  check: Pick<StoredAutomationCheck, "consecutiveFailures" | "status">,
): boolean {
  return (
    check.status === "drift" ||
    check.status === "credentials" ||
    (check.status === "error" && check.consecutiveFailures >= 3)
  );
}

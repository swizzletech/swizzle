// The rules both control plane stores apply to API check and API contact records, kept free of
// the database driver so callers can inspect a proposed deployment before opening a store.
import { parseIntervalToMs } from "@swizzle/config";
import { CronExpressionParser } from "cron-parser";
import type {
  ApiContactObservation,
  StoredApiContact,
  StoredAutomationCheck,
  StoredDeployment,
} from "./control-plane-types.js";

/** The check a deployment asks for, or null when its `api_check` is not active. */
export function deploymentCheckInput(
  deployment: Pick<StoredDeployment, "config">,
): { readonly entrypoint: string; readonly everyMs: number } | null {
  const apiCheck = deployment.config.api_check;
  if (apiCheck?.mode !== "active") return null;
  return { entrypoint: apiCheck.entrypoint, everyMs: parseIntervalToMs(apiCheck.every) };
}

/**
 * How long a passive automation may go without reaching its API before it shows as untested:
 * `untested_after`, or twice the cron interval when that is longer, so a monthly job is not
 * untested between its runs. A cron expression counts the gap between its next two runs.
 */
export function untestedThresholdMs(
  untestedAfter: string,
  trigger: { readonly cronIntervalMs: number | null; readonly cronSchedule: string | null } | null,
  from: Date,
): number {
  const configured = parseIntervalToMs(untestedAfter);
  let intervalMs = trigger?.cronIntervalMs ?? null;
  if (intervalMs === null && trigger?.cronSchedule) {
    try {
      const [first, second] = CronExpressionParser.parse(trigger.cronSchedule, {
        currentDate: from,
        tz: "UTC",
      }).take(2);
      if (first !== undefined && second !== undefined) {
        intervalMs = second.getTime() - first.getTime();
      }
    } catch {
      // The trigger row already shows an unparsable schedule as invalid.
    }
  }
  return Math.max(configured, 2 * (intervalMs ?? 0));
}

/**
 * Folds one attempt's view of a host into its stored row. A notice stays once seen and ages out
 * through `noticeSeenAt`; it counts as new when the host had none, or announces another sunset.
 * Attempts can finish out of order, so a notice older than the stored one only adds to the count.
 */
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

/** Whether a check record belongs under Overview > Needs you. */
export function checkNeedsAttention(
  check: Pick<StoredAutomationCheck, "consecutiveFailures" | "status">,
): boolean {
  return (
    check.status === "drift" ||
    check.status === "credentials" ||
    (check.status === "error" && check.consecutiveFailures >= 3)
  );
}

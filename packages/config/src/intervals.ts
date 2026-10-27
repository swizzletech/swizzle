/**
 * Pure, browser-safe interval parsing and formatting. Kept in its own module
 * (no `node:*`, `yaml`, or `zod` imports) so the dashboard can import it
 * without pulling Node-only dependencies into the browser bundle.
 *
 * Shared between the CLI and the dashboard so the `trigger.every` shorthand
 * stays in sync when the grammar evolves — single source of truth for the
 * config contract.
 */

const INTERVAL_PATTERN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const MIN_INTERVAL_MS = 30_000;

export function parseIntervalToMs(interval: string): number {
  const match = INTERVAL_PATTERN.exec(interval.trim());
  if (!match || match[0] === "") {
    throw new Error(
      `Invalid interval format: "${interval}". Use combinations like 30s, 5m, 1h, 2h30m, 1d.`,
    );
  }

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const ms = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1_000;

  if (ms < MIN_INTERVAL_MS) {
    throw new Error(`Interval ${interval} is too short. Minimum interval is 30s.`);
  }

  return ms;
}

/**
 * Inverse of {@link parseIntervalToMs}: render a millisecond interval in the
 * same shorthand the config schema accepts (`trigger.every`): `5m`, `1h`,
 * `2h30m`, `2m30s`, `1d`. Rounds to whole seconds; every non-zero part is
 * shown, concatenated without separator.
 */
export function formatIntervalMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join("") || "0s";
}

/** A placement wait is independent of the minimum interval between cron ticks. */
export function parseQueueTimeoutToMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (match === null) throw new Error("Expected a positive placement wait, such as 24h or 500ms.");
  const scales: Readonly<Record<string, number>> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const scale = scales[match[2] ?? ""];
  if (scale === undefined) throw new Error("Unsupported placement duration unit.");
  const milliseconds = Number(match[1]) * scale;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
    throw new Error("Placement wait must be a positive safe duration.");
  return milliseconds;
}

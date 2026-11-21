import { setTimeout as delay } from "node:timers/promises";

export const WAKE_SETTLE_MS = 90_000;
const PAUSE_THRESHOLD_MS = 3_000;

export interface WakeGate {
  observe(serverDate: string | null): void;
  settled(): boolean;
  untilSettled(signal: AbortSignal): Promise<void>;
}

export function createWakeGate(now: () => number = () => performance.now()): WakeGate {
  let lead: number | undefined;
  let pausedAt = Number.NEGATIVE_INFINITY;
  const settled = () => now() - pausedAt >= WAKE_SETTLE_MS;
  return {
    observe(serverDate) {
      const server = Date.parse(serverDate ?? "");
      if (Number.isNaN(server)) return;
      const local = now();
      const observed = server - local;
      if (lead !== undefined && observed - lead > PAUSE_THRESHOLD_MS) pausedAt = local;
      if (lead === undefined || observed > lead) lead = observed;
    },
    settled,
    async untilSettled(signal) {
      while (!settled()) await delay(pausedAt + WAKE_SETTLE_MS - now(), undefined, { signal });
    },
  };
}

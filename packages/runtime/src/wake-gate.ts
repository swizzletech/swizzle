// Keeps a remote worker from taking work while its machine is only half awake.
//
// A closed MacBook sleeps, and macOS wakes it for about 45 seconds at a time (DarkWake) before
// it sleeps again. Docker Desktop's VM runs during each DarkWake, so the worker reconnects and,
// without this gate, pulls a run that the next sleep cuts off: the lease expires and the run
// spends a retry attempt. The VM's clocks stand still while the host sleeps (measured on Docker
// Desktop 4.73, macOS 26.5), so the worker notices a pause only by comparing the API's Date
// header with its own monotonic clock. After a pause it pulls no new assignment until it has
// stayed awake for the settle window.
import { setTimeout as delay } from "node:timers/promises";

/** Longer than the 45-second DarkWake macOS uses for maintenance and network wakes. */
export const WAKE_SETTLE_MS = 90_000;
/** A gap between the server's and the worker's clocks beyond Date's 1 s resolution and jitter. */
const PAUSE_THRESHOLD_MS = 3_000;

export interface WakeGate {
  /** Records one API reply by its Date header, read when the reply arrived. */
  observe(serverDate: string | null): void;
  /** True when no pause was seen within the settle window. */
  settled(): boolean;
  /** Resolves once settled; rejects when the signal aborts. */
  untilSettled(signal: AbortSignal): Promise<void>;
}

/** `now` is the worker's monotonic clock, injectable for tests. */
export function createWakeGate(now: () => number = () => performance.now()): WakeGate {
  // How far the server's clock is ahead of the worker's, at most: the reply that spent the least
  // time in transit. Replies of concurrent requests arrive out of order, and a delayed one shows a
  // smaller lead, so it never lowers this. A pause raises the lead by the time the worker stood still.
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

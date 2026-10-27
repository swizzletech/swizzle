// Workers in words: their state, kind and the tone of their dot. Placement and disk words come from
// @swizzle/db through the API.

import type { WorkerStatus } from "../api";
import type { Tone } from "./health";
import { ageInWords } from "./time";

/** "Online", "Draining", "Offline, last seen 3 h ago", "Awaiting enrollment", "Revoked". */
export function workerStateInWords(
  worker: Pick<WorkerStatus, "state" | "draining" | "lastSeenAt">,
  now: Date,
): string {
  if (worker.state === "online") return worker.draining ? "Draining" : "Online";
  if (worker.state === "offline")
    return worker.lastSeenAt === null
      ? "Offline, never connected"
      : `Offline, last seen ${ageInWords(worker.lastSeenAt, now)}`;
  return worker.state === "pending" ? "Awaiting enrollment" : "Revoked";
}

/** The dot of a worker: running work blinks, an idle online one is green, a gap is amber. */
export function workerTone(worker: WorkerStatus): Tone {
  if (worker.state !== "online") return "idle";
  if (worker.draining || worker.localLlm === "unhealthy") return "warn";
  return worker.slotsInUse > 0 ? "run" : "ok";
}

export function workerKindInWords(kind: "local" | "remote"): string {
  return kind === "local" ? "Local" : "Remote";
}

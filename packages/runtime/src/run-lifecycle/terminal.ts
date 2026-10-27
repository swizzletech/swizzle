import type { ControlPlaneStore, StoredRun } from "@swizzle/db";
import { processRunNotifications } from "../notifications.js";
import { processChainTriggers } from "./chains.js";
import { resumeParentAfterChildTerminal } from "./waits.js";

/** Replayed from a committed terminal intent, including exhausted worker leases. */
export async function processRunTerminalEffects(input: {
  run: StoredRun;
  store: ControlPlaneStore;
}): Promise<void> {
  await processRunNotifications(input);
  await processChainTriggers({ ...input, retryFailures: true });
  await resumeParentAfterChildTerminal({
    retryFailures: true,
    childRun: input.run,
    store: input.store,
  });
}

import { type ControlPlaneStore, isOpenRun, runState, type StoredRun } from "@swizzle/db";
import { processRunNotifications } from "../notifications.js";
import { processChainTriggers } from "./chains.js";
import { resumeParentAfterChildTerminal } from "./waits.js";

export async function processRunTerminalEffects(input: {
  run: StoredRun;
  store: ControlPlaneStore;
}): Promise<void> {
  const { run, store } = input;
  if (runState(run) === "cancelled") {
    const children = await store.listChildRuns({ parentRunId: run.runId });
    const finishedAt = new Date().toISOString();
    for (const child of children) {
      if (isOpenRun(child.status)) {
        await store.cancelRun({ cause: "parent", finishedAt, runId: child.runId });
      }
    }
  } else {
    await processRunNotifications(input);
    await processChainTriggers({ ...input, retryFailures: true });
  }
  await resumeParentAfterChildTerminal({
    retryFailures: true,
    childRun: input.run,
    store: input.store,
  });
}

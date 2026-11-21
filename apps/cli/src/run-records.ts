import type { RunResponse as RunDetailRecord, RunsResponse } from "@swizzle/runtime/http-contract";
import { outputFormat } from "./output.js";

export type RunSummaryRecord = RunsResponse["runs"][number];
export type { RunDetailRecord };

export function runOutcome(run: Pick<RunDetailRecord, "state" | "status">) {
  return {
    ...(outputFormat() === "json" ? { status: run.status } : {}),
    state: run.state,
  };
}

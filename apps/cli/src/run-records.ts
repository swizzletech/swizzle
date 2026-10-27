import type { RunsResponse } from "@swizzle/runtime/http-contract";
export type RunSummaryRecord = RunsResponse["runs"][number];
export type { RunResponse as RunDetailRecord } from "@swizzle/runtime/http-contract";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { isOpenRun, type RunDetail } from "./api";
import { useDashboardClient } from "./dashboard-client";
import { type RunPosition, type TrackStep, waitingStep } from "./track";
import { type RunStepEvent, useRunLogStream } from "./use-run-log-stream";

export function useRunPosition(run: RunDetail): {
  position: RunPosition;
  steps: readonly TrackStep[];
  ready: boolean;
} {
  const { api, queryScope } = useDashboardClient();
  const open = isOpenRun(run.status);
  const stepsQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => api.listRunSteps(run.runId),
    queryKey: ["run-steps", run.runId, open, ...queryScope],
    refetchInterval: open ? 5_000 : false,
  });
  const stream = useRunLogStream(run.runId, open);
  const steps = useMemo(
    () => mergeStepEvents(stepsQuery.data ?? [], stream.steps),
    [stepsQuery.data, stream.steps],
  );
  return useMemo(
    () => ({
      position: {
        steps: new Map(steps.map((step) => [step.stepKey, step])),
        waiting: waitingStep(run),
        ...(run.cancelledWaitStepKey == null || run.finishedAt === null
          ? {}
          : {
              cancelledWait: { stepKey: run.cancelledWaitStepKey, at: Date.parse(run.finishedAt) },
            }),
      },
      ready: stepsQuery.data !== undefined,
      steps,
    }),
    [run, steps, stepsQuery.data],
  );
}

export function mergeStepEvents(
  read: readonly TrackStep[],
  events: readonly RunStepEvent[],
): readonly TrackStep[] {
  const steps = new Map(read.map((step) => [step.stepKey, step]));
  for (const event of events) {
    const existing = steps.get(event.key);
    if (existing !== undefined) {
      if (existing.finishedAt !== null || event.executionNumber < existing.executionNumber)
        continue;
      if (
        event.status === "started" &&
        existing.startedAt !== null &&
        existing.startedAt > event.timestamp
      ) {
        continue;
      }
    }
    const step: TrackStep = {
      ...(existing ?? {
        approval: null,
        createdAt: event.timestamp,
        finishedAt: null,
        startedAt: null,
        stepKey: event.key,
        updatedAt: event.timestamp,
        value: null,
      }),
      attempt: event.attempt,
      executionNumber: event.executionNumber,
    };
    steps.set(
      event.key,
      event.status === "started"
        ? { ...step, startedAt: event.timestamp }
        : { ...step, finishedAt: event.timestamp },
    );
  }
  return [...steps.values()];
}

// A run's position on its flow, live: the steps read from the API, with the step events of the
// run's log stream merged over them so a station lights the moment the worker reports it, well
// before the next poll. The run itself comes from the caller, which already polls it.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { isOpenRun, type RunDetail } from "./api";
import { useDashboardClient } from "./dashboard-client";
import { type RunPosition, type TrackStep, waitingStep } from "./track";
import { type RunStepEvent, useRunLogStream } from "./use-run-log-stream";

export function useRunPosition(run: RunDetail): {
  position: RunPosition;
  steps: readonly TrackStep[];
  /** False until the first steps read answered; a replay built before that would be empty. */
  ready: boolean;
} {
  const { api, queryScope } = useDashboardClient();
  const open = isOpenRun(run.status);
  const stepsQuery = useQuery({
    placeholderData: keepPreviousData,
    queryFn: () => api.listRunSteps(run.runId),
    // The same key as the run panel's Steps tab; `open` in it reads once more when the run ends.
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
      },
      ready: stepsQuery.data !== undefined,
      steps,
    }),
    [run, steps, stepsQuery.data],
  );
}

/**
 * A stream event only adds what the read does not have yet: a finished row is final, an event of
 * an older execution than the row's is history, and a start never moves a start the read already
 * placed later.
 */
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

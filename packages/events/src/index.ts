export type TriggerType = "webhook" | "cron" | "chain";
export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "dead-lettered";

export interface RunQueuedEvent {
  readonly type: "run.queued";
  readonly runId: string;
  readonly automationId: string;
  readonly triggerType: TriggerType;
  readonly queuedAt: string;
}

export interface RunFinishedEvent {
  readonly type: "run.finished";
  readonly runId: string;
  readonly automationId: string;
  readonly status: Exclude<RunStatus, "queued" | "running" | "waiting">;
  readonly finishedAt: string;
}

export type SwizzleEvent = RunQueuedEvent | RunFinishedEvent;

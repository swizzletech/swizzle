/**
 * One durable suspension. Each reason carries only its own data. Deadlines are UTC ISO strings
 * from Date.toISOString(), so the database can index and compare them in text order.
 */
export type RunWait =
  | { readonly reason: "sleep"; readonly stepKey: string; readonly until: string }
  | { readonly reason: "child"; readonly stepKey: string }
  // Set and cleared in the transaction that claims the key, so no other reader sees it.
  | { readonly reason: "claim"; readonly stepKey: string }
  | {
      readonly reason: "event";
      readonly stepKey: string;
      readonly until: string | null;
      readonly startedAt: string;
      readonly details: unknown;
    }
  | {
      readonly reason: "approval";
      readonly stepKey: string;
      readonly until: string | null;
      readonly startedAt: string;
      readonly details: unknown;
      readonly assignee: ApprovalAssignee | null;
    };

export type PlatformRunWaitReason = RunWait["reason"];

/** The wait an execution suspended at: what the run's next execution resumed after. */
export type ExecutionWait = Pick<RunWait, "reason" | "stepKey">;

/**
 * Whom an automation asks to decide, as `requestApproval` names them: a person by email or a
 * team by name. The worker resolves it to an ApprovalAssignee when the run starts to wait.
 */
export type AssigneeRequest = { readonly user: string } | { readonly team: string };

/**
 * Who may decide an approval (ADR 0014): one person, or whoever is a member of one team when
 * they decide. Ids are stable; `label` is the email or team name when the wait was assigned. An
 * assignee who later loses access or leaves decides nothing; an owner or admin reassigns.
 */
export type ApprovalAssignee =
  | { readonly kind: "user"; readonly userId: string; readonly label: string }
  | { readonly kind: "team"; readonly teamId: string; readonly label: string };

/**
 * Who decided: a signed-in person or the holder of the approval link (ADR 0012). A token never
 * decides an approval.
 */
export type ApprovalDecider =
  | { readonly kind: "person"; readonly userId: string; readonly label: string }
  | { readonly kind: "link" };

export interface RunApproval {
  /** Null when the automation named nobody: then its link, or anyone who may run it, decides. */
  readonly assignee: ApprovalAssignee | null;
  readonly stepKey: string;
  readonly details: unknown;
}

/**
 * The step result of an approval wait: what the automation reads when it resumes, and the
 * durable record of who decided.
 */
export type ApprovalDecision =
  | {
      readonly timedOut: false;
      readonly approved: boolean;
      readonly assignee: ApprovalAssignee | null;
      readonly decidedBy: ApprovalDecider;
      readonly comment: string | null;
      readonly decidedAt: string;
    }
  | {
      readonly timedOut: true;
      readonly approved: false;
      readonly assignee: ApprovalAssignee | null;
      readonly decidedBy: null;
      readonly comment: null;
      readonly decidedAt: string;
    };

/** Stored step results distinguish platform decisions from arbitrary user JSON. */
export type RunStepResult =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "approval"; readonly value: ApprovalDecision };

export type StepResultInput =
  | { readonly value: unknown; readonly approval?: never }
  | { readonly approval: ApprovalDecision; readonly value?: never };

export function storedStepResult(input: StepResultInput): RunStepResult {
  return input.approval === undefined
    ? { kind: "value", value: input.value }
    : { kind: "approval", value: input.approval };
}

/** The JSON bytes a result counts against its run's step limits. */
export function stepResultBytes(input: StepResultInput): number {
  return Buffer.byteLength(JSON.stringify(storedStepResult(input).value), "utf8");
}

export function stepResultView(result: RunStepResult | null): {
  readonly value: unknown;
  readonly approval: ApprovalDecision | null;
} {
  return {
    value: result?.value ?? null,
    approval: result?.kind === "approval" ? result.value : null,
  };
}

/** Whether two assignees name the same person or team. */
export function sameAssignee(a: ApprovalAssignee | null, b: ApprovalAssignee | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "user") return b.kind === "user" && a.userId === b.userId;
  return b.kind === "team" && a.teamId === b.teamId;
}

/** The current approval is read directly from the run, independent of attempt history. */
export function getRunApproval(run: {
  readonly status: string;
  readonly wait: RunWait | null;
}): RunApproval | null {
  if (run.status !== "waiting" || run.wait?.reason !== "approval") return null;
  return { assignee: run.wait.assignee, details: run.wait.details, stepKey: run.wait.stepKey };
}

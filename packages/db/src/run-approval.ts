export type RunWait =
  | { readonly reason: "sleep"; readonly stepKey: string; readonly until: string }
  | { readonly reason: "child"; readonly stepKey: string }
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

export type ExecutionWait = Pick<RunWait, "reason" | "stepKey">;

export type AssigneeRequest = { readonly user: string } | { readonly team: string };

export type ApprovalAssignee =
  | { readonly kind: "user"; readonly userId: string; readonly label: string }
  | { readonly kind: "team"; readonly teamId: string; readonly label: string };

export type ApprovalDecider =
  | { readonly kind: "person"; readonly userId: string; readonly label: string }
  | { readonly kind: "link" };

export interface RunApproval {
  readonly assignee: ApprovalAssignee | null;
  readonly stepKey: string;
  readonly details: unknown;
}

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

export function sameAssignee(a: ApprovalAssignee | null, b: ApprovalAssignee | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "user") return b.kind === "user" && a.userId === b.userId;
  return b.kind === "team" && a.teamId === b.teamId;
}

export function getRunApproval(run: {
  readonly status: string;
  readonly wait: RunWait | null;
}): RunApproval | null {
  if (run.status !== "waiting" || run.wait?.reason !== "approval") return null;
  return { assignee: run.wait.assignee, details: run.wait.details, stepKey: run.wait.stepKey };
}

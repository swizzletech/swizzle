// The Overview in words: the status sentence, platform problems, Needs you keys, recent changes and
// what "Hand to agent" copies for a failing run or automation.

import type { AttentionItem, DeploymentChange, Overview, PlatformProblem } from "../api";

/**
 * "All good." or "3 things need you.", split so the page can set the emphasis. Needs you leaves out
 * what the viewer cannot act on, so then an empty list says only that nothing needs them.
 */
export function statusSentence(overview: Pick<Overview, "complete" | "needsYou">): {
  readonly lead: string;
  readonly emphasis: string;
} {
  const count = overview.needsYou.length;
  if (count === 0) {
    return overview.complete
      ? { emphasis: "good.", lead: "All" }
      : { emphasis: "needs you.", lead: "Nothing" };
  }
  return count === 1
    ? { emphasis: "needs you.", lead: "1 thing" }
    : { emphasis: "need you.", lead: `${count} things` };
}

/** The title and the next step of a platform problem. */
export function platformProblemInWords(problem: PlatformProblem): {
  readonly title: string;
  readonly todo: string;
} {
  switch (problem.code) {
    case "no-worker":
      return {
        title:
          problem.queuedRuns > 0
            ? `No worker is running, ${problem.queuedRuns} ${problem.queuedRuns === 1 ? "run is" : "runs are"} queued.`
            : "No worker is running, so no run can start.",
        todo: "Start one with `docker compose up -d worker` on the server.",
      };
    case "queue-unreachable":
      return {
        title: "The run queue does not answer, so new runs cannot start.",
        todo: "Check Valkey with `docker compose ps valkey` on the server.",
      };
    case "scheduler-down":
      return {
        title: `No scheduler runs for ${problem.environment}, so its cron runs do not start and its waits do not end.`,
        todo:
          problem.served.length === 0
            ? "Start it with `docker compose up -d scheduler` on the server."
            : `The scheduler serves ${problem.served.join(" and ")}. Deploy to ${problem.served.join(" or ")}, or set \`SWIZZLE_ENVIRONMENT=${problem.environment}\` in \`.env\` and run \`just stack\` on the server.`,
      };
    case "queue-backlog":
      return {
        title: `${problem.waitingJobs} runs are waiting for a free worker.`,
        todo: "Add a worker or raise its concurrency if this does not clear.",
      };
    case "maintenance-failing":
      return {
        title: "Cleanup of old runs and logs is not running.",
        todo: "Read the scheduler log with `docker compose logs scheduler` on the server.",
      };
    case "run-image-disk":
      return problem.warning;
  }
}

/** Stable key of a Needs you row, for React lists and e2e selectors. */
export function attentionKey(item: AttentionItem): string {
  switch (item.kind) {
    case "approval":
      return `approval:${item.runId}:${item.stepKey}`;
    case "failing":
    case "trigger-invalid":
    case "api-check":
    case "api-untested":
      return `${item.kind}:${item.automation.automationSlug}`;
    case "api-sunset":
      return `api-sunset:${item.automation.automationSlug}:${item.contact.host}`;
    case "waiting-for-worker":
      return `waiting-for-worker:${item.automation.automationSlug}:${item.group}`;
    case "missing-secret":
      return `missing-secret:${item.project.id}:${item.secretName}`;
    case "missing-connection":
      return `missing-connection:${item.project.id}:${item.connectionName}:${item.status}`;
    case "platform":
      return item.problem.code === "run-image-disk"
        ? `platform:run-image-disk:${item.problem.worker}`
        : `platform:${item.problem.code}`;
    case "notifications-failed":
      return "notifications-failed";
  }
}

/**
 * What "Hand to agent" copies for a failed run: the situation and the commands the agent
 * investigates with, so the agent starts from the same facts the owner sees.
 */
export function failedRunHandoff(run: {
  readonly attemptsMade: number;
  readonly automationName: string;
  readonly errorMessage: string | null;
  readonly runId: string;
}): string {
  const attempts = run.attemptsMade === 1 ? "1 attempt" : `${run.attemptsMade} attempts`;
  return (
    `Run ${run.runId} of ${run.automationName} failed after ${attempts}: ` +
    `${sentence(run.errorMessage)} ${investigate(run.runId)}`
  );
}

/** What "Hand to agent" copies for an automation that keeps failing, from its Needs you row. */
export function failingAutomationHandoff(
  item: Extract<AttentionItem, { readonly kind: "failing" }>,
): string {
  return (
    `${item.automation.automationName} is failing: ${item.failedRuns} of its last ` +
    `${item.recentRuns} runs failed. The latest failed run is ${item.lastFailedRunId}: ` +
    `${sentence(item.errorMessage)} ${investigate(item.lastFailedRunId)}`
  );
}

function sentence(errorMessage: string | null): string {
  return (errorMessage ?? "it ended without a result").replace(/\.?$/u, ".");
}

function investigate(runId: string): string {
  return (
    `Investigate with \`swizzle diagnose ${runId}\` and \`swizzle logs --run ${runId}\`, ` +
    "fix the cause and redeploy."
  );
}

/** "Deployed" with "1.0.0 → 1.1.0", "Rolled back" with "2.3.0 → 2.2.1", "First deploy" with "1.0.0". */
export function changeInWords(
  change: Pick<DeploymentChange["change"], "eventType" | "previousVersion" | "version">,
): { readonly verb: string; readonly versions: string } {
  if (change.previousVersion === null) return { verb: "First deploy", versions: change.version };
  return {
    verb: change.eventType === "rollback" ? "Rolled back" : "Deployed",
    versions: `${change.previousVersion} → ${change.version}`,
  };
}

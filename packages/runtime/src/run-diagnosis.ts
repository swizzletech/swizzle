import type { RunWait } from "@swizzle/db";

// Explains why a run ended as it did, or why a queued run has not started, from its record, the
// automation's secrets and its deployments. `swizzle diagnose` prints it and
// GET /runs/:runId/diagnosis serves it to the dashboard's run panel, so both say the same thing.

import type { CredentialState, RunPlacement } from "@swizzle/db";
import { placementInWords } from "@swizzle/db";
import type { Diagnosis, DiagnosisEvidence, DiagnosisFix } from "./platform-records.js";
import { exceptionSummary, findRunException } from "./run-exception.js";

/** The fields of a run record the diagnosis reads. */
export interface DiagnosableRun {
  readonly attempts?: readonly {
    readonly metadata?: Record<string, unknown>;
    readonly status: string;
  }[];
  readonly attemptsMade: number;
  readonly attemptsMax: number;
  readonly automationName?: string;
  readonly automationSlug?: string;
  readonly deadLetterReason?: string | null;
  readonly deploymentId?: string;
  readonly environment?: string;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  /** Why a queued run waits for a worker; the API attaches it to a queued run. */
  readonly placement?: RunPlacement | null;
  readonly projectId?: string;
  readonly runId: string;
  readonly status: string;
  readonly stderr?: string | null;
  readonly triggerType: string;
  readonly wait?: RunWait | null;
}

export interface SecretHealthRecord {
  readonly name: string;
  readonly state: CredentialState;
}

export interface DiagnosableDeployment {
  readonly deploymentId: string;
  readonly status: string;
}

interface StderrHeuristic {
  readonly evidenceKind: string;
  readonly fix: {
    readonly command?: string;
    readonly rationale: string;
  };
  readonly pattern: RegExp;
  readonly summaryOverride?: string;
}

const STDERR_HEURISTICS: readonly StderrHeuristic[] = [
  {
    evidenceKind: "EXTERNAL_CONNECTION_REFUSED",
    fix: {
      rationale:
        "External service refused the connection — check the URL and that the service is reachable from the worker network.",
    },
    pattern: /ECONNREFUSED/,
    summaryOverride:
      "External service refused the connection — check the URL and that the service is reachable from the worker network.",
  },
  {
    evidenceKind: "FILESYSTEM_PERMISSION_DENIED",
    fix: {
      rationale:
        "Filesystem permission denied — declare writable directories under runtime.permissions.writable_dirs in config.yaml.",
    },
    pattern: /EACCES|EPERM/,
    summaryOverride:
      "Filesystem permission denied — declare writable directories under runtime.permissions.writable_dirs in config.yaml.",
  },
  {
    evidenceKind: "NODE_MODULE_MISSING",
    fix: {
      command: "pnpm add $1",
      rationale:
        'Node.js module "$1" is missing. Add it to package.json dependencies and refresh the lockfile before redeploying.',
    },
    pattern: /Cannot find module '([^']+)'/,
    summaryOverride: 'Node.js module "$1" is missing from the deployed bundle or dependency set.',
  },
  {
    evidenceKind: "PYTHON_MODULE_MISSING",
    fix: {
      rationale: 'Python module "$1" is missing. Add it to requirements.txt before redeploying.',
    },
    pattern: /ModuleNotFoundError: No module named '([^']+)'/,
    summaryOverride:
      'Python module "$1" is missing from requirements.txt or the packaged environment.',
  },
];

export function buildDiagnosis(
  run: DiagnosableRun,
  secretHealth: readonly SecretHealthRecord[] | undefined,
  deployments: readonly DiagnosableDeployment[] | undefined,
): Diagnosis {
  const evidence: DiagnosisEvidence[] = [];
  const fixes: DiagnosisFix[] = [];
  const errorCode = run.errorCode ?? null;
  const lostSecrets = (secretHealth ?? []).filter((s) => s.state !== "bound");
  const missingSecrets = lostSecrets.map((s) => s.name);
  const stderrTail = run.stderr ? run.stderr.split("\n").slice(-20).join("\n") : null;

  if (errorCode) {
    evidence.push({ detail: run.errorMessage ?? "(no message)", kind: `error:${errorCode}` });
  }
  if (run.deadLetterReason) {
    evidence.push({ detail: run.deadLetterReason, kind: "dead_letter_reason" });
  }
  if (missingSecrets.length > 0) {
    evidence.push({
      detail: `${missingSecrets.length} secret(s) missing: ${missingSecrets.join(", ")}`,
      kind: "secrets_missing",
    });
    // The deployment bound its secrets at publish, so a secret set since needs a new deploy.
    for (const secret of lostSecrets) {
      fixes.push(
        secret.state === "missing"
          ? {
              command: `swizzle secret set ${secret.name} --value '<replace-me>' && swizzle apply`,
              confidence: 0.95,
              rationale: `Declared secret "${secret.name}" is missing from the platform secret store.`,
            }
          : {
              command: "swizzle apply",
              confidence: 0.95,
              rationale: `Declared secret "${secret.name}" was set again after this deploy, which bound the one before.`,
            },
      );
    }
  }
  if (deployments && deployments.length > 0) {
    const active = deployments.find((d) => d.status === "active");
    if (active && run.deploymentId && active.deploymentId !== run.deploymentId) {
      evidence.push({
        detail: `run executed against deployment ${run.deploymentId}, current active is ${active.deploymentId}`,
        kind: "deployment_drift",
      });
    }
  }

  const stderrHeuristic = applyStderrHeuristics(stderrTail, evidence, fixes);
  const exception = findRunException(run.stderr ?? "");
  if (exception !== null) {
    evidence.push({ kind: "exception", detail: exceptionSummary(exception) });
    if (exception.message.startsWith("KeyError:")) {
      fixes.push({
        confidence: 0.8,
        rationale:
          "Inspect the missing key at the reported line. If it reads the payload, compare the payload with the expected fields. Fix the code, redeploy, then replay the run.",
        command: `swizzle runs inspect ${run.runId}`,
      });
    }
  }

  let likelyCode: string;
  let summary: string;
  const placement = run.status === "queued" ? (run.placement ?? null) : null;
  // A queued run's wait decides its cause; an earlier attempt's error stays in the evidence.
  if (placement !== null) {
    const words = placementInWords(placement, run);
    likelyCode = "WAITING_FOR_WORKER";
    summary = words.summary;
    evidence.push({ detail: `PLACEMENT_TIMEOUT at ${placement.deadline}`, kind: "deadline" });
    for (const worker of placement.workers) {
      evidence.push({
        detail: `${worker.name}: ${worker.draining ? "draining" : worker.state}, last seen ${worker.lastSeenAt ?? "never"}${worker.services.length > 0 ? `, local-llm ${worker.localLlm ?? "unreported"}` : ""}`,
        kind: "worker",
      });
    }
    fixes.push(...words.fixes);
  } else
    switch (errorCode) {
      case "MISSING_REQUIRED_SECRETS":
      case "PLATFORM_REQUIRED_SECRETS_MISSING":
        likelyCode = "MISSING_SECRETS";
        summary = "Automation cannot start because required secrets are missing.";
        break;
      case "PROCESS_TIMEOUT":
        likelyCode = "TIMEOUT";
        summary = "Automation exceeded the configured timeout.";
        fixes.push({
          confidence: 0.75,
          rationale: "Increase runtime.timeout in config.yaml or reduce work per run.",
        });
        break;
      case "RUNTIME_TIMEOUT_EXCEEDS_MAX":
        likelyCode = "TIMEOUT_POLICY";
        summary = "Automation requested a timeout above the platform ceiling.";
        fixes.push({
          confidence: 0.85,
          rationale:
            "Lower runtime.timeout in config.yaml or raise SWIZZLE_MAX_RUN_TIMEOUT for this installation.",
        });
        break;
      case "PROCESS_STDOUT_INVALID_JSON":
        likelyCode = "INVALID_STDOUT_JSON";
        summary = "Automation printed non-JSON to stdout. Keep stdout reserved for JSON results.";
        break;
      case "PROCESS_STDOUT_EMPTY":
        likelyCode = "EMPTY_STDOUT";
        summary = "Automation exited successfully but did not print a JSON result.";
        break;
      case "PROCESS_OUTPUT_LIMIT_EXCEEDED":
        likelyCode = "OUTPUT_TOO_LARGE";
        summary = "Automation wrote more stdout/stderr than the runtime capture limit allows.";
        fixes.push({
          confidence: 0.85,
          rationale: "Keep stdout to the final JSON result and reduce noisy stderr logging.",
        });
        break;
      case "PROCESS_EXIT_NON_ZERO":
        likelyCode = stderrHeuristic.likelyCode ?? "AUTOMATION_CRASHED";
        summary =
          (exception === null ? stderrHeuristic.summary : exceptionSummary(exception)) ??
          "Automation process exited non-zero. Inspect stderr for the root cause.";
        break;
      case "UPSTREAM_CONTRACT_CHANGED":
        // The message names the field the automation's own parser reported, see api-signals.ts.
        likelyCode = "UPSTREAM_CONTRACT_CHANGED";
        summary = run.errorMessage ?? "The answer of an API the automation calls changed.";
        fixes.push({
          command: "swizzle run --check <automation-dir>",
          confidence: 0.8,
          rationale:
            "Update the response parsing the entrypoint and its check share to the new shape, confirm with the check, then redeploy with `swizzle apply`. The run is not retried: a retry cannot fix a changed API.",
        });
        break;
      case "RUNTIME_REQUIREMENTS_UNMET":
        likelyCode = "RUNTIME_MISMATCH";
        summary = "The worker does not satisfy the declared runtime requirements.";
        break;
      case "INTERPRETER_NOT_FOUND":
      case "LANGUAGE_RUNTIME_UNAVAILABLE":
        likelyCode = "RUNTIME_MISMATCH";
        summary = "No compatible runtime is available on the worker.";
        break;
      case "DEPENDENCY_PACKAGING_FAILED":
        likelyCode = "DEPENDENCY_FAILURE";
        summary =
          "Requirements install failed on the worker before the automation process started. See stderr, fix the dependency manifest, then re-apply.";
        fixes.push({
          command: "swizzle apply <automation-dir>",
          confidence: 0.8,
          rationale:
            "After fixing requirements.txt/package.json/lockfile, apply the automation again so workers materialize the corrected source.",
        });
        break;
      case "APPROVAL_ASSIGNEE_NOT_FOUND":
        // The message names the email or team that matched nobody.
        likelyCode = "APPROVAL_ASSIGNEE_NOT_FOUND";
        summary = run.errorMessage ?? "The approval's assignee has no account here.";
        fixes.push({
          confidence: 0.9,
          rationale:
            "Invite that person (`swizzle people invite`) or create that team (`swizzle teams create`), or name an assignee who has an account here in the automation's requestApproval call, then run the automation again.",
        });
        break;
      case "DEPLOYMENT_ARTIFACTS_MISSING":
        likelyCode = "ARTIFACTS_MISSING";
        summary =
          "Deployment artifacts are missing from the artifact backend — the run cannot materialize.";
        fixes.push({
          command: "swizzle apply <automation-dir> --force",
          confidence: 0.9,
          rationale:
            "Redeploy with --force so a fresh artifact bundle is written even when source and config are unchanged.",
        });
        break;
      default:
        if (missingSecrets.length > 0) {
          likelyCode = "MISSING_SECRETS";
          summary = "Declared secrets are missing from the platform store.";
        } else if (run.status === "succeeded") {
          likelyCode = "HEALTHY";
          summary = "Run succeeded — nothing to diagnose.";
        } else if (run.status === "waiting") {
          likelyCode = "WAITING";
          if (run.wait?.reason === "sleep") {
            summary = `Run is durably sleeping${run.wait.until ? ` until ${run.wait.until}` : ""}.`;
          } else if (run.wait?.reason === "child") {
            summary = "Run is waiting for a child automation to finish.";
          } else if (run.wait?.reason === "event" || run.wait?.reason === "approval") {
            const approval = run.wait?.reason === "approval";
            const kind = approval ? "human approval on" : "event";
            const hint = approval
              ? " Its assignee decides it signed in to the dashboard; an unassigned one also through the approval link the run sent."
              : "";
            summary = `Run is waiting for ${kind} step "${run.wait.stepKey}"${run.wait.until ? ` until ${run.wait.until}` : ""}.${hint}`;
          } else {
            summary = "Run is waiting for an external resume condition.";
          }
        } else if (stderrHeuristic.likelyCode && stderrHeuristic.summary) {
          likelyCode = stderrHeuristic.likelyCode;
          summary = stderrHeuristic.summary;
        } else {
          likelyCode = errorCode ?? "UNCLASSIFIED";
          summary = run.errorMessage ?? `Run ended with status=${run.status}.`;
        }
    }

  return {
    attempts: { made: run.attemptsMade, max: run.attemptsMax },
    automation: run.automationName ?? run.automationSlug ?? null,
    deadLetterReason: run.deadLetterReason ?? null,
    errorCode,
    errorMessage: run.errorMessage ?? null,
    evidence,
    likelyCause: { code: likelyCode, summary },
    runId: run.runId,
    status: run.status,
    stderrTail,
    suggestedFixes: fixes,
    triggerType: run.triggerType,
  };
}

function applyStderrHeuristics(
  stderrTail: string | null,
  evidence: DiagnosisEvidence[],
  fixes: DiagnosisFix[],
): { readonly likelyCode?: string; readonly summary?: string } {
  if (!stderrTail) {
    return {};
  }

  let likelyCode: string | undefined;
  let summary: string | undefined;
  const existingRationales = new Set(fixes.map((fix) => fix.rationale));

  for (const heuristic of STDERR_HEURISTICS) {
    const match = heuristic.pattern.exec(stderrTail);
    if (!match) {
      continue;
    }

    const detail = interpolateHeuristicTemplate(heuristic.summaryOverride ?? match[0], match);
    evidence.push({
      detail,
      kind: heuristic.evidenceKind,
    });

    const rationale = interpolateHeuristicTemplate(heuristic.fix.rationale, match);
    if (!existingRationales.has(rationale)) {
      fixes.push({
        ...(heuristic.fix.command !== undefined
          ? { command: interpolateHeuristicTemplate(heuristic.fix.command, match) }
          : {}),
        confidence: 0.85,
        rationale,
      });
      existingRationales.add(rationale);
    }

    if (
      heuristic.summaryOverride !== undefined &&
      likelyCode === undefined &&
      summary === undefined
    ) {
      likelyCode = heuristic.evidenceKind;
      summary = detail;
    }
  }

  return {
    ...(likelyCode !== undefined ? { likelyCode } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

function interpolateHeuristicTemplate(template: string, match: RegExpExecArray): string {
  return template.replaceAll(/\$(\d+)/g, (_full, index: string) => match[Number(index)] ?? "");
}

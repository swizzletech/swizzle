import { checkNeedsAttention } from "@swizzle/db";
// API checks: an automation with `api_check.mode: active` ships a read-only check script that the
// platform runs on its own schedule and once after each deploy. A check is its own
// `automation_checks` record, never a run: it creates no run row, reads and writes no state, and
// counts toward no run statistic. The scheduler enqueues due checks onto the automation's profile
// queue; a worker claims one as a leased attempt, and the attempt service prepares it here and
// records its outcome here.
//
// Passive recording lives here too: every run and check hands its `api_contact` events to
// `recordApiContactLog`, which stores them and alerts once on a new retirement notice. Recording
// is best effort: a failed write is logged and never decides a run's or a check's outcome.

import type {
  ControlPlaneStore,
  ExecutionLease,
  ExecutionSignals,
  StoredApiContact,
  StoredAutomationCheck,
  StoredConnectionUsage,
  StoredSecretUsage,
} from "@swizzle/db";
import { ExecutionLeaseError } from "@swizzle/db";
import { ApiContactLog, readStructuredEvents } from "./api-signals.js";
import { type CheckOutcome, checkOutcome, nextCheckState } from "./check-contract.js";
import { type PreparedExecution, prepareDeployedExecution } from "./deployed-execution.js";
import { getErrorMessage } from "./errors.js";
import { sendApiAlert } from "./notifications.js";
import { type OutputRedactor, redactRunResult } from "./output-redaction.js";
import type { PlatformLogger } from "./platform-types.js";
import type { RunQueueProducer } from "./run-queue.js";
import type { AutomationRunResult } from "./run-result.js";
import { createQueueNameForProfile } from "./runtime-requirements.js";
import { apiCheckSecretNames } from "./validation.js";

const MAX_STDERR_TAIL_CHARS = 4_096;

/**
 * Enqueues every due check of an environment; the job ID carries the due time, so a tick that sees
 * it again adds nothing. An automation has at most one check, so the list stays as short as the
 * environment's active automations, and a check stuck on an absent profile delays no other.
 */
export async function enqueueDueChecks(input: {
  readonly environment: string;
  readonly now?: Date;
  readonly queue: RunQueueProducer;
  readonly store: ControlPlaneStore;
}): Promise<readonly StoredAutomationCheck[]> {
  const due = await input.store.listDueAutomationChecks(
    (input.now ?? new Date()).toISOString(),
    input.environment,
  );
  for (const check of due) {
    await input.queue.enqueueCheck({
      checkId: check.checkId,
      dueAt: check.nextCheckAt,
      queueName: createQueueNameForProfile(check.profile),
    });
  }
  return due;
}

/** A lease on an API check, as the attempt service holds it. */
export type CheckLease = ExecutionLease & { readonly checkId: string; readonly dueAt: string };

/** The deployment whose check is still due at the lease's time, or null when it moved on. */
export async function dueCheck(store: ControlPlaneStore, lease: CheckLease) {
  const check = await store.getAutomationCheck(lease.checkId);
  if (check === null || check.nextCheckAt !== lease.dueAt) return null;
  const deployment = await store.getDeploymentById(check.deploymentId);
  if (deployment === null || deployment.config.api_check?.mode !== "active") return null;
  return { check, deployment };
}

/**
 * Prepares a claimed check for its worker: the deployed source, the check's own secrets and the
 * automation's connection tokens. A check keeps the secret and token versions it received for its
 * record, written with its outcome.
 */
export async function prepareCheckExecution<T>(
  input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly lease: CheckLease;
    readonly store: ControlPlaneStore;
  },
  use: (prepared: PreparedExecution) => Promise<T>,
): Promise<T> {
  const due = await dueCheck(input.store, input.lease);
  if (due === null) throw new ExecutionLeaseError();
  const injectedAt = new Date().toISOString();
  let connectionUsages: readonly StoredConnectionUsage[] = [];
  let secretUsages: readonly StoredSecretUsage[] = [];
  return await prepareDeployedExecution(
    {
      deployment: due.deployment,
      environment: input.environment,
      recordConnectionUsages: async (connections) => {
        connectionUsages = connections.map((connection) => ({
          connectionName: connection.name,
          environment: connection.environment,
          injectedAt,
          provider: connection.provider,
          tokenVersion: connection.tokenVersion,
        }));
      },
      recordSecretUsages: async (secrets) => {
        secretUsages = secrets.map((secret) => ({
          algorithm: secret.algorithm,
          environment: secret.environment,
          injectedAt,
          keyVersion: secret.keyVersion,
          secretName: secret.name,
          secretVersion: secret.secretVersion,
        }));
      },
      secretNames: apiCheckSecretNames(due.deployment.config),
      store: input.store,
    },
    async (prepared) =>
      use({
        options: { ...prepared.options, runId: `check-${due.check.checkId}` },
        redacted: prepared.redacted,
        connectionUsages,
        secretUsages,
      }),
  );
}

/**
 * Records a check's outcome under its lease. `execution` is the accepted, unredacted report, or
 * the error that kept the check from running, which makes the outcome undecided. A check whose
 * due time moved on, as after a deploy, records nothing.
 */
export async function finishCheckExecution(input: {
  readonly execution: AutomationRunResult | { readonly error: unknown };
  readonly lease: CheckLease;
  /** The contacts the check's output reported, also when an error ended it. */
  readonly signals: ExecutionSignals;
  readonly logger?: PlatformLogger;
  readonly redactor: OutputRedactor;
  readonly connectionUsages: readonly StoredConnectionUsage[];
  readonly secretUsages: readonly StoredSecretUsage[];
  readonly store: ControlPlaneStore;
}): Promise<StoredAutomationCheck | null> {
  const { lease, redactor, store } = input;
  const due = await dueCheck(store, lease);
  if (due === null) return null;
  const { check, deployment } = due;
  let ignoredState = false;
  let execution: AutomationRunResult | null = null;
  let outcome: CheckOutcome;
  if ("error" in input.execution) {
    outcome = {
      exitCode: null,
      message: redactor.text(getErrorMessage(input.execution.error)),
      output: null,
      report: { ok: false, checked: [], change: null },
      status: "error",
    };
  } else {
    readStructuredEvents("", `${input.execution.stderr}\n`, (event) => {
      if (["state_set", "state_delete", "step_start", "step_result"].includes(event.type))
        ignoredState = true;
    });
    execution = redactRunResult(input.execution, redactor);
    outcome = checkOutcome(execution);
  }

  const next = nextCheckState(check, outcome, new Date());
  const warning = [
    outcome.status === "error" ? outcome.message : null,
    ignoredState
      ? "The check printed state or step events; checks hold no state, so they were ignored."
      : null,
  ]
    .filter((line) => line !== null)
    .join(" ");
  const written = await store.completeAutomationCheck({
    ...next,
    checkId: check.checkId,
    connectionUsages: input.connectionUsages,
    dueAt: lease.dueAt,
    exitCode: execution?.exitCode ?? (outcome.status === "error" ? outcome.exitCode : null),
    secretUsages: input.secretUsages,
    stderrTail: execution === null ? null : tail(execution.stderr, MAX_STDERR_TAIL_CHARS),
    warning: warning === "" ? null : warning,
  });
  await recordApiContactLog({
    automation: deployment,
    environment: deployment.environment,
    log: new ApiContactLog(input.signals.contacts),
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
    redactor,
    store,
  });
  if (!written) return null;

  const recorded = await store.getAutomationCheck(check.checkId);
  if (recorded !== null && !checkNeedsAttention(check) && checkNeedsAttention(recorded)) {
    await sendApiAlert({
      alert: {
        automation: { ...recorded, projectId: deployment.projectId },
        environment: recorded.environment,
        eventType: "api-check",
        key: `${recorded.checkId}:${recorded.failingSince}`,
        lines: [
          `check: ${recorded.entrypoint}`,
          `status: ${recorded.status}${recorded.lastExitCode === null ? "" : ` (exit ${recorded.lastExitCode})`}`,
          ...(recorded.lastOutput === null ? [] : [`output: ${tail(recorded.lastOutput, 500)}`]),
          ...(recorded.lastWarning === null ? [] : [`note: ${recorded.lastWarning}`]),
          `failing since: ${recorded.failingSince}`,
        ],
        metadata: {
          checkId: recorded.checkId,
          consecutiveFailures: recorded.consecutiveFailures,
          status: recorded.status,
        },
      },
      store,
    });
  }
  return recorded;
}

/**
 * Stores what one run or check saw of each API host, and alerts once for each retirement notice
 * the write recorded first. The notice path and link pass through the attempt's redactor. It
 * never throws: a failure is logged, and the next attempt that reaches the host records it again.
 */
export async function recordApiContactLog(input: {
  readonly automation: {
    readonly automationId: string;
    readonly automationName: string;
    readonly automationSlug: string;
    readonly projectId: string;
  };
  readonly environment: string;
  readonly log: ApiContactLog;
  readonly logger?: PlatformLogger;
  readonly redactor: OutputRedactor;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const contacts = input.log.observations(input.redactor);
  if (contacts.length === 0) return;
  try {
    await storeApiContacts({ ...input, contacts });
  } catch (error) {
    input.logger?.warn(
      { automationId: input.automation.automationId, error: getErrorMessage(error) },
      "Could not record API contacts.",
    );
  }
}

async function storeApiContacts(
  input: Parameters<typeof recordApiContactLog>[0] & {
    readonly contacts: ReturnType<ApiContactLog["observations"]>;
  },
): Promise<void> {
  const notices = await input.store.recordApiContacts({
    automationId: input.automation.automationId,
    contacts: input.contacts,
    environment: input.environment,
  });
  for (const contact of notices) {
    await sendApiAlert({
      alert: {
        automation: input.automation,
        environment: input.environment,
        eventType: "api-sunset",
        key: `${input.automation.automationId}:${contact.host}:${contact.sunsetAt ?? contact.deprecatedAt}`,
        lines: noticeLines(contact),
        metadata: {
          deprecatedAt: contact.deprecatedAt,
          host: contact.host,
          sunsetAt: contact.sunsetAt,
        },
      },
      store: input.store,
    });
  }
}

function noticeLines(contact: StoredApiContact): string[] {
  return [
    `api: ${contact.host}`,
    ...(contact.sunsetAt === null ? [] : [`sunset: ${contact.sunsetAt}`]),
    ...(contact.deprecatedAt === null ? [] : [`deprecated: ${contact.deprecatedAt}`]),
    ...(contact.noticePath === null ? [] : [`first seen on: ${contact.noticePath}`]),
    ...(contact.noticeUrl === null ? [] : [`notice: ${contact.noticeUrl}`]),
  ];
}

function tail(text: string, maxChars: number): string | null {
  const trimmed = text.trimEnd();
  if (trimmed === "") return null;
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

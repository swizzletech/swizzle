import { type ApiErrorCode, type ApiErrorResponse, isApiErrorCode } from "@swizzle/core";
import {
  AutomationRuntimeError,
  type AutomationRuntimeErrorCode,
  BackupError,
} from "@swizzle/runtime";

import { AgentError, EXIT_CODES, exitCodeForError } from "./output.js";

/** Executable fixes for errors where one concrete command is the next step. */
const FIX_COMMANDS: Partial<Record<ApiErrorCode, string>> = {
  ACTIVE_DEPLOYMENT_NOT_FOUND: "swizzle apply <dir>",
  FORBIDDEN: "swizzle doctor",
  MISSING_ENCRYPTION_KEY: "swizzle doctor",
  PLATFORM_REQUIRED_SECRETS_MISSING: "swizzle secret set <name> --value-env <VAR>",
  PROJECT_MOVE_TARGET_NOT_FOUND: "swizzle projects",
  PROJECT_NOT_FOUND: "swizzle projects",
  SECRET_ALREADY_EXISTS: "swizzle secret set <name> --value-env <VAR> --overwrite",
  TRIGGER_PAUSED: "swizzle trigger resume <name>",
  UNAUTHORIZED: "swizzle profile add <name> --url <api-url> --token-env <VAR>",
};

const RUNTIME_HINTS: Partial<Record<AutomationRuntimeErrorCode, string>> = {
  ACCESS_DENIED:
    "Your role does not allow this. details.sources lists the grants you hold; a project admin grants more with `swizzle projects grant`. `swizzle whoami --project <project>` shows your role.",
  ACTIVE_DEPLOYMENT_NOT_FOUND: "Deploy the automation first with `swizzle apply <dir>`.",
  AUTOMATION_NOT_FOUND:
    "No automation of this name exists in this environment. `swizzle list` shows the ones you can see; `swizzle apply <dir>` deploys one.",
  ARTIFACT_STORAGE_NOT_WRITABLE:
    "The platform artifact backend needs operator repair. For local Docker volumes, ensure the mounted artifacts directory is owned by UID/GID 10001:10001; for S3, verify bucket write/delete permissions.",
  AUTOMATION_CONFIG_INVALID:
    "Fix config.yaml so it matches the schema, then rerun `swizzle validate`.",
  AUTOMATION_CONFIG_NOT_FOUND:
    "Create a config.yaml or scaffold a fresh folder with `swizzle init <dir>`.",
  AUTOMATION_ENTRYPOINT_NOT_FOUND:
    "Create the entrypoint file or update config.yaml `entrypoint` to the correct relative path.",
  AUTOMATION_ENTRYPOINT_OUTSIDE_DIRECTORY:
    "Keep the entrypoint inside the automation folder. Use a relative path like main.py.",
  AUTOMATION_ENTRYPOINT_UNSUPPORTED: "Use a supported entrypoint type: .py, .js, or .ts.",
  AUTOMATION_PROJECT_MISMATCH:
    "Automation names are unique across projects. Rename the automation in config.yaml, or deploy it to the project it belongs to.",
  CREDENTIAL_AMBIGUOUS:
    "Several projects share a credential of this name with the project. Ask a project admin to drop all but one share, or set the credential in the project itself.",
  CREDENTIAL_CHANGED:
    "Someone created, deleted or replaced this credential in the meantime. Look at it with `swizzle secret list` or `swizzle connections inspect <name>`, then retry.",
  CREDENTIAL_USE_DENIED:
    "This version uses a credential you may not use. Ask someone who manages it to grant you use, or remove it from config.yaml.",
  DEPLOYMENT_CREDENTIALS_CHANGED:
    "A credential changed while deploying. Run `swizzle apply` again.",
  AUTOMATION_STATE_LIMIT_EXCEEDED:
    "Keep each state value under 64KB and total automation state under 5MB.",
  DEPENDENCY_CACHE_DIR_MISSING:
    "Set SWIZZLE_DEP_CACHE_DIR in the worker environment. The Compose stack sets it to /data/dep-cache.",
  DEPENDENCY_MANIFEST_MISSING:
    "Create the declared requirements.txt / package.json / lockfile, or remove the declaration from config.yaml.",
  DEPENDENCY_PACKAGING_FAILED:
    "Requirements install failed on the worker or local run. Inspect stderr, fix requirements.txt/package.json/lockfile, then re-apply.",
  DEPLOYMENT_ARTIFACTS_MISSING:
    "The deployment artifacts are missing from the artifact backend. Re-deploy or pick a deployment whose artifacts still exist.",
  DEPLOYMENT_NOT_FOUND: "Check `swizzle deployments <name>` for valid deployment IDs.",
  INTERPRETER_NOT_FOUND:
    "Install the required local runtime (python3 for Python, workspace deps for TypeScript).",
  INVALID_ENCRYPTION_KEY: "Provide a real 32-byte raw or base64-encoded SWIZZLE_ENCRYPTION_KEY.",
  INVALID_PAYLOAD_FILE_JSON: "Fix the JSON file contents or regenerate sample-payload.json.",
  INVALID_PAYLOAD_JSON: "Pass valid JSON to --payload, or prefer --payload-file.",
  LANGUAGE_RUNTIME_UNAVAILABLE:
    "Make sure the matching worker (or local machine) actually provides the declared language.",
  MISSING_ENCRYPTION_KEY: "Export SWIZZLE_ENCRYPTION_KEY before using secret commands.",
  MISSING_REQUIRED_SECRETS:
    "Export the missing secret names in your current shell before running locally.",
  PAYLOAD_OPTIONS_CONFLICT: "Choose either --payload or --payload-file, not both.",
  PLATFORM_REQUIRED_SECRETS_MISSING:
    "Run `swizzle secret set <name>` for every missing secret, then deploy again with `swizzle apply <dir>`.",
  PROJECT_NOT_FOUND:
    "No project of this name that you can see; one you hold no role in reads as missing.",
  PROCESS_EXIT_NON_ZERO:
    "Inspect stderr logs above. Only exit with code 0 when the automation succeeds.",
  PROCESS_OUTPUT_LIMIT_EXCEEDED:
    "Reduce stdout/stderr volume. Successful automations should print only final JSON to stdout and logs to stderr.",
  PROCESS_SIGNAL: "The automation process was killed. Increase timeout or inspect crash cause.",
  PROCESS_STDOUT_EMPTY:
    "Successful runs must print one JSON result to stdout. Send logs to stderr instead.",
  PROCESS_STDOUT_INVALID_JSON:
    "Keep stdout valid JSON only. Move human-readable logs and debug prints to stderr.",
  PROCESS_TIMEOUT:
    "Reduce local work or increase runtime.timeout in config.yaml (values like 30s or 5m).",
  ROLLBACK_CONFLICT:
    "Resolve the trigger path conflict before rolling back, or rollback to a compatible deployment.",
  RUNTIME_TIMEOUT_EXCEEDS_MAX:
    "Lower runtime.timeout or ask the operator to raise SWIZZLE_MAX_RUN_TIMEOUT for this installation.",
  RUNTIME_REQUIREMENTS_UNMET:
    "No worker meets what the automation declares; the error names each unmet requirement. `swizzle validate <dir>` checks them before a deploy, `swizzle worker groups` lists the groups that serve the project.",
  RUN_NOT_FOUND:
    "Check `swizzle runs` for valid run IDs. Runs are pruned based on retention config.",
  SECRET_ALREADY_EXISTS:
    "Run `swizzle secret inspect <name>` to see what depends on it, then re-run with --overwrite if you really want to rotate.",
  TIMEOUT_FORMAT_INVALID: "Use timeout values like 500ms, 30s, 5m, or 1h in config.yaml.",
  TRIGGER_CONFIGURATION_INVALID: "Fix the trigger block in config.yaml.",
  TRIGGER_NOT_FIRABLE:
    "A chain automation runs when its sources succeed. Trigger a source, or run it locally with `swizzle run <dir>`.",
  TRIGGER_NOT_FOUND: "Deploy the automation first, or check `swizzle list`.",
  TRIGGER_PAUSED:
    "Automatic firing is paused. Use `swizzle trigger <name>` for one manual run, or `swizzle trigger resume <name>` to re-enable automatic firing.",
  TRIGGER_WEBHOOK_PATH_CONFLICT:
    "Another deployment claims the same webhook path. Change `trigger.path` in config.yaml.",
  UPSTREAM_CONTRACT_CHANGED:
    "The API's answer no longer matches what the code expects, so the run is not retried. Update the response parsing to the new shape, confirm with `swizzle run --check .`, then redeploy with `swizzle apply .`.",
  WEBHOOK_PAYLOAD_INVALID:
    "Send a payload that matches trigger.payload_schema, or update the declared schema and redeploy.",
};

const RUNTIME_RETRYABLE = new Set<AutomationRuntimeErrorCode>([
  "PROCESS_TIMEOUT",
  "DEPENDENCY_PACKAGING_FAILED",
]);

/** The copyable choices for a config that reaches an outside API without an `api_check` decision. */
const API_CHECK_DECISION_HINT = [
  "Add one of these to config.yaml:",
  "  api_check: { mode: active }",
  "  api_check: { mode: passive }",
  '  api_check: { mode: off, reason: "<why>" }',
  "active runs a read-only check script beside the entrypoint every 7d and after each deploy; `swizzle init` scaffolds one. passive adds no calls. off needs a reason, for example paid per call.",
].join("\n");

function runtimeHint(code: string, message: string): string | undefined {
  if (
    code === "AUTOMATION_CONFIG_INVALID" &&
    /\bapi_check: uses (secret|connection) /u.test(message)
  ) {
    return API_CHECK_DECISION_HINT;
  }
  return RUNTIME_HINTS[code as AutomationRuntimeErrorCode];
}

export function mapRuntimeErrorToAgentError(error: AutomationRuntimeError): AgentError {
  const exitCode = exitCodeForError(error.code);
  const hint = runtimeHint(error.code, error.message) ?? fallbackHint(exitCode);
  const fixCommand = FIX_COMMANDS[error.code];
  return new AgentError({
    code: error.code,
    message: error.message,
    retryable: RUNTIME_RETRYABLE.has(error.code),
    exitCode,
    hint,
    ...(fixCommand !== undefined ? { fixCommand } : {}),
    ...(error.details !== undefined && isPlainObject(error.details)
      ? { details: error.details as Record<string, unknown> }
      : {}),
  });
}

/** An external error may be partial or come from a proxy outside the API catalogue. */
export type ApiErrorBody = Partial<Omit<ApiErrorResponse, "code" | "error">> & {
  readonly error?: string;
};

export function mapApiErrorToAgentError(
  status: number,
  body: ApiErrorBody | undefined,
  url: string,
): AgentError {
  const code = body?.error ?? `HTTP_${status}`;
  const message = body?.message ?? `HTTP ${status} from ${url}`;
  const exitCode =
    code === "CONFIRMATION_REQUIRED" ? EXIT_CODES.usage : exitCodeForError(code, status);
  let hint = instanceRoleHint(code, body?.details) ?? runtimeHint(code, message);
  if (hint === undefined) {
    if (code === "CONFIRMATION_REQUIRED") hint = "";
    else if (code === "PROJECT_NOT_EMPTY" && typeof body?.details?.project === "string")
      hint = `Or run \`swizzle projects delete ${body.details.project} --delete-contents --yes\` to delete what it holds with it; audit events stay either way.`;
    else hint = apiHint(isApiErrorCode(code) ? code : undefined, status) ?? fallbackHint(exitCode);
  }
  const fixCommand =
    (isApiErrorCode(code) ? concreteFixCommand(code, body?.details) : undefined) ??
    (isApiErrorCode(code) ? FIX_COMMANDS[code] : undefined);
  const retryable = body?.retryable ?? (status >= 500 || status === 408 || status === 429);

  return new AgentError({
    code,
    message,
    retryable,
    exitCode,
    ...(fixCommand === undefined
      ? { hint: hint || fallbackHint(exitCode) }
      : { fixCommand, ...(hint.length > 0 ? { hint } : {}) }),
    details: { ...compactDetails(body?.details), httpStatus: status },
  });
}

/**
 * An instance-wide action names the instance role it needs and no project grants, so the project
 * hint for ACCESS_DENIED would point the wrong way.
 */
function instanceRoleHint(
  code: string,
  details: Record<string, unknown> | undefined,
): string | undefined {
  if (code !== "ACCESS_DENIED" || details === undefined || "sources" in details) return undefined;
  if (typeof details.required !== "string") return undefined;
  const yours = typeof details.role === "string" ? `; yours is ${details.role}` : "";
  return `This needs the instance role ${details.required}${yours}. An instance owner or admin does it, or changes your role in Settings > People.`;
}

/** The fixing command with the names the error carries filled in, where it carries them. */
function concreteFixCommand(
  code: ApiErrorCode,
  details: Record<string, unknown> | undefined,
): string | undefined {
  const environment = typeof details?.environment === "string" ? ` -e ${details.environment}` : "";
  if (code === "PLATFORM_REQUIRED_SECRETS_MISSING" && Array.isArray(details?.missingSecrets)) {
    const [first] = details.missingSecrets;
    if (typeof first === "string")
      return `swizzle secret set ${first} --value-env <VAR>${environment}`;
  }
  if (code === "PROJECT_NOT_EMPTY" && typeof details?.project === "string")
    return `swizzle projects delete ${details.project} --move-to <project> --yes`;
  if (
    code === "CONFIRMATION_REQUIRED" &&
    typeof details?.project === "string" &&
    details.environment === undefined
  ) {
    let choice = "";
    if (details.contents === "move" && typeof details.to === "string")
      choice = ` --move-to ${details.to}`;
    else if (details.contents === "delete") choice = " --delete-contents";
    return `swizzle projects delete ${details.project}${choice} --yes`;
  }
  if (
    code === "CONFIRMATION_REQUIRED" &&
    typeof details?.project === "string" &&
    typeof details?.environment === "string"
  ) {
    return `swizzle projects unprotect ${details.project} ${details.environment} --yes`;
  }
  if (
    code === "ENVIRONMENT_NOT_PROTECTED" &&
    typeof details?.project === "string" &&
    typeof details?.environment === "string"
  ) {
    return `swizzle projects protect ${details.project} ${details.environment}`;
  }
  if (code === "SECRET_ALREADY_EXISTS" && typeof details?.name === "string") {
    return `swizzle secret set ${details.name} --value-env <VAR> --overwrite${environment}`;
  }
  return undefined;
}

/**
 * A deploy's readiness report names every worker and queue it checked; the agent needs what was
 * unmet and where, so only that part travels in `details`.
 */
function compactDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const readiness = details?.readiness;
  if (typeof readiness !== "object" || readiness === null) return details ?? {};
  const report = readiness as {
    readonly status?: unknown;
    readonly profile?: unknown;
    readonly matchingWorkerCount?: unknown;
    readonly errors?: readonly { readonly code?: unknown; readonly subject?: unknown }[];
  };
  return {
    ...details,
    readiness: {
      status: report.status,
      profile: report.profile,
      matchingWorkers: report.matchingWorkerCount,
      unmet: (report.errors ?? []).map(
        (error) => `${String(error.code)} (${String(error.subject)})`,
      ),
    },
  };
}

/** API refusals whose next step the generic status hint would not name. */
const API_HINTS: Partial<Record<ApiErrorCode, string>> = {
  REQUEST_INVALID: "Inspect details. The API rejected the body shape.",
  ENVIRONMENT_NOT_PROTECTED:
    "Or drop --on-environment: a project grant already reaches every unprotected environment.",
  AUTH_ACCOUNT_SUSPENDED:
    "The person this token belongs to is suspended, so a new token would be refused too. Ask an owner or admin of this instance to lift the suspension in Settings > People.",
  CONNECTION_NOT_FOUND:
    "No connection of this name in this environment. `swizzle connections list` lists them.",
  NOTIFICATION_RULE_NOT_FOUND: "No such rule. `swizzle notify list` lists the rules and their ids.",
  PROJECT_NOT_EMPTY:
    "Run `swizzle projects delete <project> --move-to <other> --yes` to keep what it holds, or `--delete-contents --yes` to delete it; audit events stay.",
  PROJECT_PROTECTED: "The default project stays; delete or move what is in it instead.",
  SECRET_NOT_FOUND: "No secret of this name in this environment. `swizzle secret list` lists them.",
  WORKER_NOT_FOUND: "No such worker. `swizzle worker list` lists the workers and their ids.",
};

function apiHint(code: ApiErrorCode | undefined, status: number): string | undefined {
  const hint = code === undefined ? undefined : API_HINTS[code];
  if (hint !== undefined) return hint;
  if (code === "UNAUTHORIZED" || status === 401)
    return "This API requires a bearer token. In the dashboard, open Settings > Agent access, create an agent token, export it and register it with `swizzle profile add <name> --url <api-url> --token-env <VAR>`.";
  if (code === "FORBIDDEN" || status === 403)
    return "The API rejected the bearer token. Check the selected profile/token env var, or have the owner create a replacement under Settings > Agent access.";
  if (status === 404) return "Not found. Check the name, ID, or environment.";
  if (status === 409)
    return "The requested state conflicts with current state. Inspect before retrying.";
  if (status === 422) return "Request was rejected. Inspect `details` for the failing field.";
  if (status === 501)
    return "The API does not support this operation in its current configuration. Check server config / feature flags.";
  if (status >= 500)
    return "The platform failed, not the request. Retry, or run `swizzle doctor` and read the API logs.";
  return undefined;
}

/** The next step for an error class when its code has no hint of its own. */
function fallbackHint(exitCode: number): string {
  switch (exitCode) {
    case EXIT_CODES.auth:
      return "Check the token of the selected profile with `swizzle whoami`.";
    case EXIT_CODES.notFound:
      return "Check the name or id and the environment (-e); `swizzle list` and `swizzle runs` show what exists.";
    case EXIT_CODES.conflict:
      return "The current state conflicts with the request. Inspect it before retrying.";
    case EXIT_CODES.validation:
      return "The request was rejected. Read `details` for the failing field, fix it and rerun.";
    case EXIT_CODES.backend:
      return "The platform failed, not the request. Retry, or run `swizzle doctor`.";
    default:
      return "Rerun with --debug to see the API requests, or run `swizzle doctor`.";
  }
}

export function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof BackupError)
    return new AgentError({ code: error.code, hint: error.hint, message: error.message });
  if (error instanceof AutomationRuntimeError) return mapRuntimeErrorToAgentError(error);
  return new AgentError({
    code: "UNEXPECTED_CLI_ERROR",
    hint: fallbackHint(EXIT_CODES.generic),
    message: error instanceof Error ? error.message : String(error),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

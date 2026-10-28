import { type ApiErrorCode, isApiErrorCode } from "@swizzle/core";
/**
 * The CLI's one output boundary, by the AXI contract. A command answers with an `Output` object,
 * and `respond` prints it on stdout as TOON, or as one line of JSON under the global `--json`. An
 * error takes the same path as `{ error, code, help }`: what went wrong, a stable code, and the
 * next step. Logs, progress and debug lines go to stderr. `swizzle logs` prints the run's streams
 * as text blocks on stdout unless `--json` is set; `--follow` streams log lines before its answer.
 */
import { encode } from "@toon-format/toon";

export type OutputFormat = "json" | "toon";

/**
 * Exit codes by failure class: 0 success (no-ops included), 2 usage, the rest refine AXI's 1.
 * `swizzle schema exit-codes` prints them.
 */
export const EXIT_CODES = {
  ok: 0,
  generic: 1,
  usage: 2,
  validation: 3,
  auth: 4,
  backend: 5,
  notFound: 6,
  rateLimit: 7,
  conflict: 8,
} as const;

const API_EXIT_CODES: Partial<Record<ApiErrorCode, number>> = {
  AUTOMATION_CONFIG_INVALID: EXIT_CODES.validation,
  AUTOMATION_STATE_LIMIT_EXCEEDED: EXIT_CODES.validation,
  INVALID_PAYLOAD_FILE_JSON: EXIT_CODES.validation,
  INVALID_PAYLOAD_JSON: EXIT_CODES.validation,
  PAYLOAD_OPTIONS_CONFLICT: EXIT_CODES.validation,
  RUNTIME_TIMEOUT_EXCEEDS_MAX: EXIT_CODES.validation,
  TIMEOUT_FORMAT_INVALID: EXIT_CODES.validation,
  TRIGGER_CONFIGURATION_INVALID: EXIT_CODES.validation,
  WEBHOOK_PAYLOAD_INVALID: EXIT_CODES.validation,
  AUTOMATION_CHAIN_CONNECTED: EXIT_CODES.conflict,
  AUTOMATION_NOT_PAUSED: EXIT_CODES.conflict,
  ROLLBACK_CONFLICT: EXIT_CODES.conflict,
  SECRET_ALREADY_EXISTS: EXIT_CODES.conflict,
  TRIGGER_PAUSED: EXIT_CODES.conflict,
  TRIGGER_WEBHOOK_PATH_CONFLICT: EXIT_CODES.conflict,
  AUTH_ACCOUNT_SUSPENDED: EXIT_CODES.auth,
  FORBIDDEN: EXIT_CODES.auth,
  UNAUTHORIZED: EXIT_CODES.auth,
  ARTIFACT_STORAGE_NOT_WRITABLE: EXIT_CODES.backend,
};

const LOCAL_EXIT_CODES = new Map<string, number>([
  ["INVALID_TIME_RANGE", EXIT_CODES.validation],
  ["INVALID_TIME_VALUE", EXIT_CODES.validation],
  ["AMBIGUOUS_AUTOMATION_NAME", EXIT_CODES.conflict],
  ["BACKUP_DESTINATION_EXISTS", EXIT_CODES.conflict],
  ["API_TIMEOUT", EXIT_CODES.backend],
  ["API_UNREACHABLE", EXIT_CODES.backend],
]);

/** Classify an error code (and optional HTTP status) into a typed exit code. */
export function exitCodeForError(code: string, status?: number): number {
  if (status !== undefined) {
    if (status === 401 || status === 403) return EXIT_CODES.auth;
    if (status === 404) return EXIT_CODES.notFound;
    if (status === 409) return EXIT_CODES.conflict;
    if (status === 429) return EXIT_CODES.rateLimit;
    if (status === 400 || status === 422) return EXIT_CODES.validation;
    if (status >= 500 || status === 408) return EXIT_CODES.backend;
  }
  const classified =
    (isApiErrorCode(code) ? API_EXIT_CODES[code] : undefined) ?? LOCAL_EXIT_CODES.get(code);
  if (classified !== undefined) return classified;
  if (code.endsWith("_NOT_FOUND")) return EXIT_CODES.notFound;
  return EXIT_CODES.generic;
}

/** What a command prints. Its keys are the command's own; `warnings` and `help` follow them. */
export type Output = { readonly [key: string]: unknown };

export interface CliIO {
  readonly stderr: (message: string) => void;
  readonly stdout: (message: string) => void;
}

/** An error names its next step: a hint, a command that fixes it, or both. */
type NextStep =
  | { readonly hint: string; readonly fixCommand?: string }
  | { readonly fixCommand: string; readonly hint?: string };

export type AgentErrorInit = {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly exitCode?: number;
} & NextStep;

export class AgentError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly fixCommand: string | undefined;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly exitCode: number;

  constructor(init: AgentErrorInit) {
    super(init.message);
    this.name = "AgentError";
    this.code = init.code;
    this.hint = init.hint;
    this.fixCommand = init.fixCommand;
    this.retryable = init.retryable ?? false;
    this.details = init.details;
    this.exitCode = init.exitCode ?? exitCodeForError(init.code);
  }

  /** `help` lists the fixing command first, then the hint. */
  toOutput(): Output {
    const help = [
      ...(this.fixCommand !== undefined ? [`Run \`${this.fixCommand}\``] : []),
      ...(this.hint !== undefined ? [this.hint] : []),
    ];
    return {
      error: this.message,
      code: this.code,
      help,
      ...(this.retryable ? { retryable: true } : {}),
      ...(this.details !== undefined && Object.keys(this.details).length > 0
        ? { details: this.details }
        : {}),
    };
  }
}

/** Thrown after an error was printed; carries only the exit code up to `runCli`. */
export class HandledCliError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super("Handled CLI error");
    this.exitCode = exitCode;
  }
}

const encoders: Record<OutputFormat, (output: Output) => string> = {
  json: (output) => JSON.stringify(output),
  toon: (output) => encode(output),
};

let format: OutputFormat = "toon";
let warnings: string[] = [];

/** Chosen once per invocation from argv, before commander parses it; also clears warnings. */
export function setOutputFormat(next: OutputFormat): void {
  format = next;
  warnings = [];
}

export function outputFormat(): OutputFormat {
  return format;
}

/** A note the next `respond` prints under `warnings`, such as a fuzzy name match. */
export function warn(message: string): void {
  warnings.push(message);
}

/** Prints `output`, then the collected warnings, then `help`: the next steps worth suggesting. */
export function respond(io: CliIO, output: Output, help: readonly string[] = []): void {
  io.stdout(`${encoders[format](withNotes(output, help))}\n`);
}

export function respondError(io: CliIO, error: AgentError): void {
  const { help, ...rest } = error.toOutput() as Output & { readonly help: readonly string[] };
  respond(io, rest, help);
}

function withNotes(output: Output, help: readonly string[]): Output {
  const notes = warnings;
  warnings = [];
  return {
    ...output,
    ...(notes.length > 0 ? { warnings: notes } : {}),
    ...(help.length > 0 ? { help } : {}),
  };
}

/**
 * The default columns of a list, plus those `--fields a,b` asks for. A field no record has is a
 * usage error that names the ones it could have asked for.
 */
export function selectFields<T extends object>(
  records: readonly T[],
  defaults: readonly (keyof T & string)[],
  fields: string | undefined,
): Output[] {
  const extra = (fields ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  const known = new Set(records.flatMap((record) => Object.keys(record)));
  const unknown = records.length === 0 ? [] : extra.filter((field) => !known.has(field));
  if (unknown.length > 0) {
    throw new AgentError({
      code: "FIELD_UNKNOWN",
      exitCode: EXIT_CODES.usage,
      hint: `Available fields: ${[...known].sort().join(", ")}`,
      message: `Unknown field: ${unknown.join(", ")}`,
    });
  }
  const columns = [...new Set<string>([...defaults, ...extra])];
  return records.map((record) =>
    Object.fromEntries(
      columns.map((column) => [column, (record as Record<string, unknown>)[column] ?? null]),
    ),
  );
}

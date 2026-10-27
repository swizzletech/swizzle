import type { ApiErrorCode } from "@swizzle/core";

/** A database or request failure whose public status is owned by the API boundary. */
export class CodedError extends Error {
  readonly fixCommand: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly fixCommand?: string;
      readonly details?: Record<string, unknown>;
    },
  ) {
    super(message, options);
    this.name = "CodedError";
    this.details = options?.details;
    this.fixCommand = options?.fixCommand;
  }
}

/** Moving requires admin of both projects, so the caller can read these same-project names. */
export function chainMoveConflict(
  automationSlug: string,
  connected: readonly string[],
): CodedError {
  const names = [...new Set(connected)].sort();
  return new CodedError(
    "AUTOMATION_CHAIN_CONNECTED",
    `Cannot move ${automationSlug} to another project while its chain connects it to ${names.join(", ")}. Move the whole project's contents together, or remove the chain first.`,
    { details: { automations: names } },
  );
}

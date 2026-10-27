import type { ApiErrorCode } from "@swizzle/core";

export type AutomationRuntimeErrorCode = ApiErrorCode;

export class AutomationRuntimeError extends Error {
  public readonly details: Record<string, unknown> | undefined;

  constructor(
    public readonly code: AutomationRuntimeErrorCode,
    message: string,
    options?: (ErrorOptions & { readonly details?: Record<string, unknown> }) | undefined,
  ) {
    super(message, options);
    this.name = "AutomationRuntimeError";
    this.details = options?.details;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

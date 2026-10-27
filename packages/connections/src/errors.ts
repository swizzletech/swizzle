export type ConnectionProviderErrorKind = "invalid-grant" | "provider-rejected" | "transient";

/**
 * Normalized provider failure. `kind` decides platform behavior:
 * - `invalid-grant`: the stored grant is dead; re-authorization is required.
 * - `provider-rejected`: the provider answered with a definitive OAuth error.
 * - `transient`: network/5xx/timeout; safe to retry without touching state.
 */
export class ConnectionProviderError extends Error {
  readonly kind: ConnectionProviderErrorKind;
  readonly providerErrorCode: string | null;

  constructor(
    message: string,
    options: {
      kind: ConnectionProviderErrorKind;
      providerErrorCode?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConnectionProviderError";
    this.kind = options.kind;
    this.providerErrorCode = options.providerErrorCode ?? null;
  }
}

const INVALID_GRANT_ERROR_CODES = new Set(["invalid_grant", "invalid_token"]);

export function providerRejection(code: string, operation: string): ConnectionProviderError {
  return new ConnectionProviderError(`OAuth provider rejected ${operation}: ${code}`, {
    kind: INVALID_GRANT_ERROR_CODES.has(code) ? "invalid-grant" : "provider-rejected",
    providerErrorCode: code,
  });
}

export function normalizeProviderError(error: unknown, operation: string): ConnectionProviderError {
  if (error instanceof ConnectionProviderError) {
    return error;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new ConnectionProviderError(
      `OAuth provider ${operation} timed out after ${PROVIDER_REQUEST_TIMEOUT_MS}ms`,
      { kind: "transient", cause: error },
    );
  }
  return new ConnectionProviderError(`OAuth provider ${operation} failed unexpectedly`, {
    kind: "transient",
    cause: error,
  });
}

export const PROVIDER_REQUEST_TIMEOUT_MS = 10_000;

import { type ApiErrorBody, mapApiErrorToAgentError } from "./errors.js";
import { AgentError, EXIT_CODES } from "./output.js";
import type { BearerToken } from "./profile.js";

/**
 * Resolve an API endpoint path against a base URL that may itself contain a
 * path prefix (e.g. `http://localhost:19826/api`). The whatwg `URL` constructor
 * replaces the base path when the second argument starts with `/`, which drops
 * any prefix the user has configured via their profile. This helper appends
 * the path to the base instead, matching operator intuition.
 *
 *   resolveApiUrl("http://localhost:19826/api",  "/deployments")
 *     -> http://localhost:19826/api/deployments
 *   resolveApiUrl("http://localhost:19820",      "/deployments")
 *     -> http://localhost:19820/deployments
 *   resolveApiUrl("https://app.example.com/api/","/runs/abc")
 *     -> https://app.example.com/api/runs/abc
 */
export function resolveApiUrl(base: string, pathname: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return new URL(normalizedPath, normalizedBase);
}

export interface ApiRequestOptions extends RequestInit {
  readonly timeoutMs?: number;
  readonly token?: BearerToken | null;
  readonly debug?: boolean;
  readonly debugLogger?: (message: string) => void;
  /**
   * Return `undefined` instead of throwing when the API responds with 404.
   * Used for existence-check patterns (e.g. "does this secret already exist?").
   */
  readonly acceptNotFound?: boolean;
}

export interface ApiAmbientContext {
  readonly token: BearerToken | null;
  readonly debug: boolean;
  readonly debugLogger?: (message: string) => void;
}

let ambientContext: ApiAmbientContext = { token: null, debug: false };

export function setApiAmbientContext(context: ApiAmbientContext): void {
  ambientContext = context;
}

export function resetApiAmbientContext(): void {
  ambientContext = { token: null, debug: false };
}

export async function apiRequest<T = unknown>(
  url: string,
  init: ApiRequestOptions = {},
): Promise<T> {
  const {
    timeoutMs = 30_000,
    token: tokenOverride,
    debug: debugOverride,
    debugLogger: debugLoggerOverride,
    acceptNotFound = false,
    ...requestInit
  } = init;

  const token = tokenOverride !== undefined ? tokenOverride : ambientContext.token;
  const debug = debugOverride !== undefined ? debugOverride : ambientContext.debug;
  const debugLogger = debugLoggerOverride ?? ambientContext.debugLogger;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const baseHeaders: Record<string, string> = {
    accept: "application/json",
    ...((requestInit.headers as Record<string, string> | undefined) ?? {}),
  };
  if (token !== undefined && token !== null && token.length > 0) {
    baseHeaders.authorization = `Bearer ${token}`;
  }

  if (debug === true) {
    const body = requestInit.body;
    const bodyBytes =
      body === undefined
        ? 0
        : body instanceof Buffer
          ? body.byteLength
          : body instanceof Uint8Array
            ? body.byteLength
            : typeof body === "string"
              ? Buffer.byteLength(body, "utf8")
              : -1;
    const log = debugLogger ?? ((message: string) => process.stderr.write(`${message}\n`));
    const headerPreview = Object.keys(baseHeaders)
      .filter((key) => key.toLowerCase() !== "authorization")
      .sort()
      .map((key) => `${key}=${baseHeaders[key]}`)
      .join(", ");
    const auth = baseHeaders.authorization !== undefined ? "Bearer <redacted>" : "none";
    log(
      `[debug] ${requestInit.method ?? "GET"} ${url}  headers: {${headerPreview}}  auth: ${auth}  body: ${bodyBytes === -1 ? "stream" : `${bodyBytes}B`}`,
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...requestInit,
      headers: baseHeaders,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) {
      throw new AgentError({
        code: "API_TIMEOUT",
        message: `API request timed out after ${timeoutMs}ms: ${url}`,
        retryable: true,
        exitCode: EXIT_CODES.backend,
        fixCommand: "swizzle doctor",
        hint: "The platform may be slow or unreachable. Retry.",
        details: { timeoutMs, url },
      });
    }
    throw new AgentError({
      code: "API_UNREACHABLE",
      message: `Could not reach Swizzle API at ${url}: ${message}`,
      retryable: true,
      exitCode: EXIT_CODES.backend,
      fixCommand: "swizzle doctor",
      hint: "Set --api-url or SWIZZLE_API_URL. The Caddy stack serves http://api.localhost:19826 (default); the dev stack prints its API URL. `swizzle profile list` shows saved profiles.",
      details: { url },
    });
  }
  clearTimeout(timer);

  if (response.status === 204) {
    return undefined as T;
  }

  if (response.status === 404 && acceptNotFound) {
    return undefined as T;
  }

  const bodyText = await response.text();
  const body = bodyText.length > 0 ? tryParseJson(bodyText) : undefined;

  if (!response.ok) {
    throw mapApiErrorToAgentError(response.status, body as ApiErrorBody | undefined, url);
  }

  return (body as T | undefined) ?? (undefined as T);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { error: "INVALID_API_RESPONSE", message: value };
  }
}

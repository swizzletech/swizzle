import { type ApiErrorBody, mapApiErrorToAgentError } from "./errors.js";
import { AgentError, EXIT_CODES } from "./output.js";
import type { BearerToken } from "./profile.js";

export const DEFAULT_API_URL = process.env.SWIZZLE_API_URL ?? "http://api.localhost:19826";

export function resolveApiUrl(base: string, pathname: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return new URL(normalizedPath, normalizedBase);
}

export interface ApiRequestOptions extends RequestInit {
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
  readonly token?: BearerToken | null;
  readonly debug?: boolean;
  readonly debugLogger?: (message: string) => void;
  readonly acceptNotFound?: boolean;
}

export interface ApiAmbientContext {
  readonly token: BearerToken | null;
  readonly apiUrl: string;
  readonly debug: boolean;
  readonly debugLogger?: (message: string) => void;
}

const defaultContext: ApiAmbientContext = { apiUrl: DEFAULT_API_URL, token: null, debug: false };
let ambientContext = defaultContext;

export function setApiAmbientContext(context: ApiAmbientContext): void {
  ambientContext = context;
}

export function resetApiAmbientContext(): void {
  ambientContext = defaultContext;
}

export async function apiRequest<T = unknown>(
  url: string,
  init: ApiRequestOptions = {},
): Promise<T> {
  const {
    apiUrl = ambientContext.apiUrl,
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

  if (response.status === 204 || (response.status === 404 && acceptNotFound)) {
    return undefined as T;
  }

  const bodyText = await response.text();
  let body: unknown;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      if (!response.ok) body = { error: "INVALID_API_RESPONSE", message: bodyText };
    }
  }

  if (!response.ok) {
    throw mapApiErrorToAgentError(response.status, body as ApiErrorBody | undefined, url);
  }
  if (bodyText.length === 0) {
    return undefined as T;
  }
  if (typeof body !== "object" || body === null) {
    throw invalidApiResponse(apiUrl, response.status);
  }

  return body as T;
}

function invalidApiResponse(apiUrl: string, httpStatus: number): AgentError {
  const suggestedUrl = new URL(apiUrl);
  const basePath = suggestedUrl.pathname.replace(/\/$/u, "");
  if (!basePath.endsWith("/api")) suggestedUrl.pathname = `${basePath}/api`;
  return new AgentError({
    code: "INVALID_API_RESPONSE",
    message: `${apiUrl} does not answer as a Swizzle API. Expected a JSON response.`,
    exitCode: EXIT_CODES.backend,
    retryable: false,
    hint: `Check the profile URL with \`swizzle profile list\`. The dashboard serves the API at ${suggestedUrl.toString()}. Set --api-url to the API URL.`,
    details: { url: apiUrl, httpStatus },
  });
}

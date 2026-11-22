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
}

export const INVALID_BODY = Symbol("invalid API response body");

export interface ResponseDecoder<T> {
  readonly decode: (body: unknown) => T | typeof INVALID_BODY;
  readonly notFound?: () => T;
}

export const noContent: ResponseDecoder<undefined> = {
  decode: (body) => (body === undefined ? undefined : INVALID_BODY),
};

export function whenFound<T>(decoder: ResponseDecoder<T>): ResponseDecoder<T | undefined> {
  return {
    decode: decoder.decode,
    notFound: () => undefined,
  };
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

export async function apiRequest<T>(
  url: string,
  decoder: ResponseDecoder<T>,
  init: ApiRequestOptions = {},
): Promise<T> {
  const {
    apiUrl = ambientContext.apiUrl,
    timeoutMs = 30_000,
    token: tokenOverride,
    debug: debugOverride,
    debugLogger: debugLoggerOverride,
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
  let bodyText: string;
  try {
    response = await fetch(url, {
      ...requestInit,
      headers: baseHeaders,
      signal: controller.signal,
    });
    if (response.status === 404 && decoder.notFound !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      return decoder.notFound();
    }
    bodyText = await response.text();
  } catch (error) {
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
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  if (bodyText.length > 0) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      if (response.ok) throw invalidApiResponse(apiUrl, response.status);
      body = { error: "INVALID_API_RESPONSE", message: bodyText };
    }
  }

  if (!response.ok) {
    throw mapApiErrorToAgentError(
      response.status,
      body as ApiErrorBody | undefined,
      url,
      response.headers.get("Retry-After"),
    );
  }
  const decoded = decoder.decode(body);
  if (decoded === INVALID_BODY) {
    throw invalidApiResponse(
      apiUrl,
      response.status,
      "The body did not match the requested endpoint.",
    );
  }
  return decoded;
}

function invalidApiResponse(
  apiUrl: string,
  httpStatus: number,
  expectation = "Expected a JSON response.",
): AgentError {
  const suggestedUrl = new URL(apiUrl);
  const basePath = suggestedUrl.pathname.replace(/\/$/u, "");
  if (!basePath.endsWith("/api")) suggestedUrl.pathname = `${basePath}/api`;
  return new AgentError({
    code: "INVALID_API_RESPONSE",
    message: `${apiUrl} does not answer as a Swizzle API. ${expectation}`,
    exitCode: EXIT_CODES.backend,
    retryable: false,
    hint: `Check the profile URL with \`swizzle profile list\`. The dashboard serves the API at ${suggestedUrl.toString()}. Set --api-url to the API URL.`,
    details: { url: apiUrl, httpStatus },
  });
}

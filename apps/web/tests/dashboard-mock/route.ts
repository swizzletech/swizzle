import type { Route } from "@playwright/test";
import type { API_ERROR_STATUS, ApiErrorCode, ApiErrorResponse } from "@swizzle/core";

export const MINUTE = 60_000;

export function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export interface MockRequest {
  readonly body: unknown;
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
}

export function readRoute(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname.replace(/^\/api/u, "");
  const method = request.method();
  const body: unknown = request.postData() === null ? null : request.postDataJSON();
  return {
    body,
    method,
    pathname,
    search: url.searchParams,
    route,
    is: (verb: string, pattern: RegExp) => method === verb && pattern.test(pathname),
    param: (pattern: RegExp) => decodeURIComponent(pattern.exec(pathname)?.[1] ?? ""),
    json: (body: unknown, status = 200) => json(route, body, status),
    apiError: <Code extends ApiErrorCode>(
      code: Code,
      status: (typeof API_ERROR_STATUS)[Code],
      message: string,
    ) => apiError(route, code, status, message),
  };
}

export type MockRoute = ReturnType<typeof readRoute>;

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", status });
}

function apiError<Code extends ApiErrorCode>(
  route: Route,
  code: Code,
  status: (typeof API_ERROR_STATUS)[Code],
  message: string,
) {
  return json(route, { code, error: code, message } satisfies ApiErrorResponse, status);
}

// The one fetch wrapper: every call goes to the API base with the session cookie, and a failed
// answer throws ApiError with the API's code, details and fix command.

import { ApiError, type ApiErrorResponse } from "../api";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

/**
 * The API's public address as the CLI reaches it from this browser's origin. The packaged stack
 * opened at `localhost` serves the API at `api.localhost` on the same port, the address the CLI
 * defaults to and install.md teaches, so the dashboard names that one.
 */
export function publicApiUrl(
  base: string = API_BASE_URL,
  origin: string = window.location.origin,
  packaged: boolean = !import.meta.env.DEV,
): string {
  const page = new URL(origin);
  if (packaged && base === "/api" && page.hostname === "localhost") {
    page.hostname = "api.localhost";
    return page.origin;
  }
  return new URL(base, page).toString().replace(/\/$/, "");
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!response.ok) {
    const errorBody = (await safeJson(response)) as ApiErrorResponse | null;
    throw new ApiError(
      errorBody?.message ?? `Request failed with status ${response.status}`,
      response.status,
      errorBody?.error,
      errorBody?.details,
      errorBody?.fixCommand,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function json(method: "POST" | "PUT", body: object): RequestInit {
  return { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

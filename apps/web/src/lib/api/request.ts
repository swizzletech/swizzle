// The one fetch wrapper: every call goes to the API base with the session cookie, and a failed
// answer throws ApiError with the API's code, details and fix command.

import { ApiError, type ApiErrorResponse } from "../api";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

/** The API's public address as the CLI reaches it from this browser's origin. */
export function publicApiUrl(): string {
  return new URL(API_BASE_URL, window.location.origin).toString().replace(/\/$/, "");
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

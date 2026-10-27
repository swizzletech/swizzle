import { randomBytes } from "node:crypto";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { AutomationRuntimeError } from "./errors.js";
import type { AutomationDefinition } from "./validation.js";

/** The worker's direct control channel. It is on runner-control, outside the run network. */
async function control(
  environment: NodeJS.ProcessEnv,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: { readonly token: string; readonly runId: string },
): Promise<unknown> {
  const origin = new URL(
    environment.SWIZZLE_LOCAL_LLM_CONTROL_URL ?? "http://local-llm-control:8081",
  );
  if (origin.protocol !== "http:" || origin.username || origin.password)
    throw new Error("SWIZZLE_LOCAL_LLM_CONTROL_URL must be an HTTP origin without credentials.");
  const token = environment.SWIZZLE_LOCAL_LLM_CONTROL_TOKEN;
  if (!token) throw new Error("Local LLM gateway control is not configured on this worker.");
  const response = await fetch(new URL(method === "GET" ? "/health" : "/grants", origin), {
    method,
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(4_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("Local LLM gateway refused the attempt or is unhealthy.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.byteLength;
    // Leaving the loop cancels the rest of the body.
    if (bytes > 4096) throw new Error("Gateway control response too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function localLlmHealth(
  environment: NodeJS.ProcessEnv,
): Promise<"disabled" | "healthy" | "unhealthy"> {
  if (!environment.SWIZZLE_LOCAL_LLM_CONTROL_TOKEN) return "disabled";
  try {
    const value = await control(environment, "GET");
    if (
      typeof value === "object" &&
      value !== null &&
      "state" in value &&
      (value.state === "healthy" || value.state === "disabled")
    )
      return value.state;
  } catch {
    /* An unavailable control listener is unhealthy too. */
  }
  return "unhealthy";
}

/** A fresh identity for this attempt only. Renewal never resets the gateway's quotas. */
export async function withLocalLlmAccess<T>(
  input: {
    readonly definition: AutomationDefinition;
    readonly environment: NodeJS.ProcessEnv;
    readonly runId: string;
    readonly signal?: AbortSignal;
  },
  use: (environment: Record<string, string>, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!input.definition.config.runtime.permissions.services.includes(LOCAL_LLM_SERVICE))
    return await use({}, input.signal);
  if (!input.definition.config.runtime.permissions.network)
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      "local-llm requires runtime.permissions.network.",
    );
  const identity = { token: randomBytes(32).toString("base64url"), runId: input.runId };
  const abort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  signal.throwIfAborted();
  try {
    await control(input.environment, "POST", identity);
  } catch (error) {
    await control(input.environment, "DELETE", identity).catch(() => {});
    throw error;
  }
  let renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewal !== null) return;
    renewal = control(input.environment, "PUT", identity)
      .then(
        () => {},
        () => abort.abort(),
      )
      .finally(() => {
        renewal = null;
      });
  }, 10_000).unref();
  const revoke = () => {
    void control(input.environment, "DELETE", identity).catch(() => {});
  };
  signal.addEventListener("abort", revoke, { once: true });
  try {
    signal.throwIfAborted();
    return await use(
      {
        SWIZZLE_LOCAL_LLM_URL: "http://local-llm-inference:8080/v1/chat/completions",
        SWIZZLE_LOCAL_LLM_TOKEN: identity.token,
      },
      signal,
    );
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", revoke);
    await renewal;
    await control(input.environment, "DELETE", identity).catch(() => {});
  }
}

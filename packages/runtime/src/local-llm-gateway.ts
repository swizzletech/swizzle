import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { addAbortSignal } from "node:stream";
// The cheap config entry: the gateway process loads no zod, ajv or yaml.
import { LOCAL_LLM_SERVICE } from "@swizzle/config/browser";
import type { LocalLlmGateway, LocalLlmPolicy } from "./local-llm.js";

const GRANT_TTL_MS = 30_000;
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
interface Grant {
  readonly runId: string;
  expiresAt: number;
  remaining: number;
  readonly active: Set<AbortController>;
}
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Literal addresses pin DNS and the port for the gateway's entire lifetime. */
export function localLlmPolicy(environment: NodeJS.ProcessEnv): LocalLlmPolicy | null {
  const configured = environment.SWIZZLE_LOCAL_LLM_UPSTREAM?.trim();
  if (!configured) return null;
  const upstream = new URL(configured);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    !isIP(upstream.hostname.replace(/^\[|\]$/gu, "")) ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== "/" ||
    upstream.search ||
    upstream.hash
  )
    throw new Error(
      "SWIZZLE_LOCAL_LLM_UPSTREAM must be an HTTP(S) origin with a literal IP address and exact port.",
    );
  const apiKey = environment.SWIZZLE_LOCAL_LLM_API_KEY;
  const model = environment.SWIZZLE_LOCAL_LLM_MODEL;
  if (!apiKey || /[\r\n]/u.test(apiKey) || !model?.trim())
    throw new Error(
      "Configure SWIZZLE_LOCAL_LLM_API_KEY and SWIZZLE_LOCAL_LLM_MODEL with the upstream.",
    );
  const limit = (name: string, fallback: number, maximum: number) => {
    const value = Number(environment[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
    return value;
  };
  return {
    upstream,
    apiKey,
    model,
    concurrency: limit("SWIZZLE_LOCAL_LLM_CONCURRENCY", 2, 32),
    requestsPerAttempt: limit("SWIZZLE_LOCAL_LLM_REQUESTS", 10, 100),
    maxTokens: limit("SWIZZLE_LOCAL_LLM_MAX_TOKENS", 512, 4096),
  };
}

/**
 * Only generated text requests cross this boundary. The run cannot supply a URL, model, tools,
 * headers or an API path. Both HTTP proxy clients and CONNECT clients reach this same listener.
 */
export function createLocalLlmGateway(input: {
  readonly policy: LocalLlmPolicy | null;
  readonly controlToken: string;
}): LocalLlmGateway {
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(input.controlToken))
    throw new Error(
      "SWIZZLE_LOCAL_LLM_CONTROL_TOKEN must contain at least 32 random bytes encoded as base64url.",
    );
  const grants = new Map<string, Grant>();
  let active = 0;
  const revoke = (key: string, grant: Grant) => {
    grants.delete(key);
    for (const controller of grant.active) controller.abort();
  };
  const prune = () => {
    for (const [key, grant] of grants) if (grant.expiresAt <= Date.now()) revoke(key, grant);
  };
  const timer = setInterval(prune, 250).unref();
  const control = createServer(async (request, response) => {
    try {
      const expected = Buffer.from(`Bearer ${input.controlToken}`);
      const received = Buffer.from(request.headers.authorization ?? "");
      if (received.length !== expected.length || !timingSafeEqual(received, expected))
        return reply(response, 403, "Control authentication required.");
      if (request.url === "/health" && request.method === "GET") {
        const healthy = await health(input.policy);
        return reply(response, 200, { service: LOCAL_LLM_SERVICE, state: healthy });
      }
      if (request.url !== "/grants") return reply(response, 404, "Unknown control path.");
      const body: unknown = JSON.parse(await readBody(request, MAX_BODY_BYTES));
      if (
        !record(body) ||
        typeof body.token !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(body.token)
      )
        return reply(response, 400, "Invalid attempt token.");
      prune();
      const key = hash(body.token);
      if (request.method === "DELETE") {
        const existing = grants.get(key);
        if (existing) revoke(key, existing);
        return reply(response, 200, { revoked: true });
      }
      if (request.method === "POST") {
        if (!input.policy || (await health(input.policy)) !== "healthy")
          return reply(response, 503, "Local LLM service is unavailable.");
        // Health yields; overlapping registrations must reuse the same quota and controllers.
        const existing = grants.get(key);
        if (typeof body.runId !== "string" || body.runId.length > 128)
          return reply(response, 400, "Invalid run identity.");
        if (existing && existing.runId !== body.runId)
          return reply(response, 403, "Attempt token already belongs to another run.");
        if (!existing) {
          if (grants.size >= 256) return reply(response, 429, "Too many active attempts.");
          grants.set(key, {
            runId: body.runId,
            remaining: input.policy.requestsPerAttempt,
            expiresAt: Date.now() + GRANT_TTL_MS,
            active: new Set(),
          });
        }
      } else if (request.method !== "PUT")
        return reply(response, 405, "Unsupported control method.");
      const grant = grants.get(key);
      if (!grant) return reply(response, 403, "Attempt token is expired or revoked.");
      grant.expiresAt = Date.now() + GRANT_TTL_MS;
      return reply(response, 200, { remainingMs: GRANT_TTL_MS });
    } catch {
      reply(response, 400, "Invalid control request.");
    }
  });
  const inference = createServer(async (request, response) => {
    let controller: AbortController | undefined;
    let grant: Grant | undefined;
    try {
      const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
      prune();
      grant = token ? grants.get(hash(token)) : undefined;
      if (!grant || !input.policy)
        return reply(response, 403, "This attempt has no local-llm permission.");
      const policy = input.policy;
      if (request.method !== "POST" || request.url !== "/v1/chat/completions")
        return reply(response, 403, "Only POST /v1/chat/completions is permitted.");
      if (active >= policy.concurrency || grant.active.size >= 1 || grant.remaining <= 0)
        return reply(response, 429, "Local LLM concurrency or attempt quota exhausted.");
      // Reserve capacity before reading a body, so slow senders are bounded too.
      controller = new AbortController();
      const currentController = controller;
      grant.active.add(controller);
      active++;
      response.on("close", () => currentController.abort());
      const body = inferenceBody(
        JSON.parse(await readBody(request, MAX_BODY_BYTES, controller.signal)),
        policy,
      );
      // Recheck after the asynchronous body read: revocation must stop an unstarted inference.
      if (controller.signal.aborted || grant.expiresAt <= Date.now())
        return reply(response, 403, "Attempt token is expired or revoked.");
      grant.remaining--;
      const upstream = await fetch(new URL("/v1/chat/completions", policy.upstream), {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${policy.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        return reply(response, 502, "Local LLM inference failed.");
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of upstream.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("Response too large.");
        chunks.push(chunk);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // The fixed upstream's response headers and any credentials never pass back to a run.
      return reply(response, 200, result);
    } catch {
      reply(
        response,
        controller?.signal.aborted ? 403 : 400,
        "Local LLM request rejected or interrupted.",
      );
    } finally {
      if (controller && grant) {
        controller.abort();
        grant.active.delete(controller);
        active--;
      }
    }
  });
  for (const server of [control, inference]) {
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.maxHeadersCount = 32;
    server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
    server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  }
  return {
    control,
    inference,
    async close() {
      clearInterval(timer);
      for (const [key, grant] of grants) revoke(key, grant);
      await Promise.all(
        [control, inference].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            }),
        ),
      );
    },
  };
}

function inferenceBody(value: unknown, policy: LocalLlmPolicy) {
  if (
    !record(value) ||
    Object.keys(value).some((key) => !["messages", "max_tokens", "temperature"].includes(key)) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 128
  )
    throw new Error("Expected text messages without tools or model overrides.");
  const messages = value.messages.map((message: unknown) => {
    if (
      !record(message) ||
      Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
      !["system", "user", "assistant"].includes(String(message.role)) ||
      typeof message.content !== "string"
    )
      throw new Error("Invalid text message.");
    return { role: message.role, content: message.content };
  });
  const maxTokens = value.max_tokens ?? policy.maxTokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > policy.maxTokens
  )
    throw new Error("Output token limit exceeded.");
  if (
    value.temperature !== undefined &&
    (typeof value.temperature !== "number" || value.temperature < 0 || value.temperature > 2)
  )
    throw new Error("Invalid temperature.");
  return {
    model: policy.model,
    messages,
    max_tokens: maxTokens,
    stream: false,
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
  };
}

async function readBody(
  request: IncomingMessage,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal) addAbortSignal(signal, request);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("Request too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(JSON.stringify(value));
}
async function health(
  policy: LocalLlmPolicy | null,
): Promise<"disabled" | "healthy" | "unhealthy"> {
  if (!policy) return "disabled";
  try {
    const response = await fetch(new URL("/health", policy.upstream), {
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
      headers: { authorization: `Bearer ${policy.apiKey}` },
    });
    await response.body?.cancel();
    return response.ok ? "healthy" : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

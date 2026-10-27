import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import { withLocalLlmAccess } from "./local-llm-access.js";
import { createLocalLlmGateway, localLlmPolicy } from "./local-llm-gateway.js";
import { loadAutomationDefinition } from "./validation.js";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function fixture(
  input: { readonly holdInference?: boolean; readonly concurrency?: string } = {},
) {
  const pendingHealth: ServerResponse[] = [];
  let pauseHealth = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(() => release());
  const received: unknown[] = [];
  let upstreamHealthy = true;
  let redirect = false;
  const upstream = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer upstream-private-key")
      return response.writeHead(403).end();
    if (request.url === "/health") {
      if (pauseHealth) {
        pendingHealth.push(response);
        return response;
      }
      return response.writeHead(upstreamHealthy ? 200 : 503).end();
    }
    if (redirect) return response.writeHead(302, { location: "http://127.0.0.1:1/admin" }).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (input.holdInference) await released;
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify({ choices: [{ message: { content: "Four." } }] }));
  });
  const origin = await listen(upstream);
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      }),
  );
  const policy = localLlmPolicy({
    SWIZZLE_LOCAL_LLM_UPSTREAM: origin,
    SWIZZLE_LOCAL_LLM_API_KEY: "upstream-private-key",
    SWIZZLE_LOCAL_LLM_MODEL: "approved-model",
    SWIZZLE_LOCAL_LLM_REQUESTS: "1",
    ...(input.concurrency === undefined
      ? {}
      : { SWIZZLE_LOCAL_LLM_CONCURRENCY: input.concurrency }),
  });
  const controlToken = randomBytes(32).toString("base64url");
  const gateway = createLocalLlmGateway({ policy, controlToken });
  const controlUrl = await listen(gateway.control);
  const inferenceUrl = await listen(gateway.inference);
  onTestFinished(() => gateway.close());
  const token = randomBytes(32).toString("base64url");
  const control = (
    method: string,
    options: {
      readonly path?: string;
      readonly authenticated?: boolean;
      readonly token?: string;
      readonly runId?: string;
    } = {},
  ) =>
    fetch(controlUrl + (options.path ?? "/grants"), {
      method,
      headers: {
        authorization: options.authenticated === false ? "Bearer wrong" : `Bearer ${controlToken}`,
        "content-type": "application/json",
      },
      ...(method === "GET"
        ? {}
        : {
            body: JSON.stringify({
              token: options.token ?? token,
              runId: options.runId ?? "run-one",
            }),
          }),
    });
  const infer = (
    body: unknown = { messages: [{ role: "user", content: "What is 2+2?" }] },
    permission = token,
    path = "/v1/chat/completions",
  ) =>
    fetch(inferenceUrl + path, {
      method: "POST",
      headers: { authorization: `Bearer ${permission}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    inferenceServer: gateway.inference,
    inferenceUrl,
    pendingHealth: () => pendingHealth.length,
    pauseHealth: () => {
      pauseHealth = true;
    },
    releaseHealth: () => {
      const response = pendingHealth.shift();
      if (response === undefined) throw new Error("No health response waiting.");
      response.writeHead(upstreamHealthy ? 200 : 503).end();
    },
    environment: {
      SWIZZLE_LOCAL_LLM_CONTROL_URL: controlUrl,
      SWIZZLE_LOCAL_LLM_CONTROL_TOKEN: controlToken,
    },
    release,
    control,
    infer,
    received,
    token,
    origin,
    unhealthy: () => {
      upstreamHealthy = false;
    },
    redirect: () => {
      redirect = true;
    },
  };
}

it("grants one attempt inference with the fixed model and bounded output; renew/replay cannot refill its quota", async () => {
  const f = await fixture();
  expect((await f.control("POST", { authenticated: false })).status).toBe(403);
  expect((await f.infer(undefined, "wrong")).status).toBe(403);
  expect((await f.control("POST")).status).toBe(200);
  const answer = await f.infer();
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ choices: [{ message: { content: "Four." } }] });
  expect(f.received).toEqual([
    {
      model: "approved-model",
      messages: [{ role: "user", content: "What is 2+2?" }],
      max_tokens: 512,
      stream: false,
    },
  ]);
  expect((await f.control("PUT")).status).toBe(200);
  expect((await f.control("POST")).status).toBe(200);
  expect((await f.infer()).status).toBe(429);
});

it("rejects management paths, model overrides, tools and excessive token requests before touching the upstream", async () => {
  const f = await fixture();
  expect((await f.control("POST")).status).toBe(200);
  expect((await f.infer({}, f.token, "/api/delete")).status).toBe(403);
  for (const extra of [
    { model: "other-model" },
    { tools: [] },
    { max_tokens: 513 },
    { stream: true },
    { url: f.origin },
  ]) {
    expect(
      (await f.infer({ messages: [{ role: "user", content: "hello" }], ...extra })).status,
    ).toBe(400);
  }
  expect((await f.infer()).status).toBe(200);
  expect(f.received).toEqual([
    {
      model: "approved-model",
      messages: [{ role: "user", content: "What is 2+2?" }],
      max_tokens: 512,
      stream: false,
    },
  ]);
});

it("revokes finished attempts, expires lost workers and reports upstream health separately", async () => {
  const f = await fixture();
  expect(await (await f.control("GET", { path: "/health" })).json()).toEqual({
    service: "local-llm",
    state: "healthy",
  });
  expect((await f.control("POST")).status).toBe(200);
  expect((await f.control("DELETE")).status).toBe(200);
  expect((await f.infer()).status).toBe(403);
  expect((await f.control("POST")).status).toBe(200);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
  expect((await f.infer()).status).toBe(403);
  expect((await f.control("PUT")).status).toBe(403);
  f.unhealthy();
  expect(await (await f.control("GET", { path: "/health" })).json()).toEqual({
    service: "local-llm",
    state: "unhealthy",
  });
  expect((await f.control("POST")).status).toBe(503);
});

it("does not follow inference redirects", async () => {
  const f = await fixture();
  expect((await f.control("POST")).status).toBe(200);
  f.redirect();
  expect((await f.infer()).status).toBe(400);
});

it("requires a literal upstream address rather than a DNS name that could change destinations", () => {
  expect(() =>
    localLlmPolicy({ SWIZZLE_LOCAL_LLM_UPSTREAM: "http://llm.example.test:8080" }),
  ).toThrow("literal IP address");
  expect(localLlmPolicy({})).toBe(null);
});

it("bounds concurrent inference and aborts an in-flight call on revocation", async ({ signal }) => {
  const f = await fixture({ holdInference: true });
  expect((await f.control("POST")).status).toBe(200);
  const first = f.infer();
  await waitFor(signal, () => f.received.length === 1);
  expect((await f.infer()).status).toBe(429);
  expect((await f.control("DELETE")).status).toBe(200);
  expect((await first).status).toBe(403);
  f.release();
});

it("the worker gives each attempt its own token and revokes it after execution returns", async () => {
  const f = await fixture();
  const directory = await temporaryDirectory("swizzle-llm-attempt-");
  await writeFile(
    path.join(directory, "config.yaml"),
    `name: local-inference
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
runtime:
  permissions:
    services: [local-llm]
`,
  );
  await writeFile(path.join(directory, "main.js"), "console.log('{}');");
  const definition = await loadAutomationDefinition(directory);
  const tokens: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await withLocalLlmAccess(
      { definition, environment: f.environment, runId: "same-run" },
      async (environment) => {
        const token = environment.SWIZZLE_LOCAL_LLM_TOKEN;
        if (token === undefined) throw new Error("Attempt token missing.");
        expect((await f.infer(undefined, token)).status).toBe(200);
        return token;
      },
    );
    tokens.push(token);
    expect((await f.infer(undefined, token)).status).toBe(403);
  }
  expect(new Set(tokens).size).toBe(2);
});

it.for(["run-one", "another-run"])(
  "overlapping registration for %s preserves the first run identity and quota",
  async (runId, { signal }) => {
    const f = await fixture();
    f.pauseHealth();
    const first = f.control("POST");
    await waitFor(signal, () => f.pendingHealth() === 1);
    const second = f.control("POST", { runId });
    await waitFor(signal, () => f.pendingHealth() === 2);
    f.releaseHealth();
    expect((await first).status).toBe(200);
    expect((await f.infer()).status).toBe(200);
    f.releaseHealth();
    expect((await second).status).toBe(runId === "run-one" ? 200 : 403);
    expect((await f.infer()).status).toBe(429);
  },
);

it("overlapping registration keeps the in-flight inference attached to revocation", async ({
  signal,
}) => {
  const f = await fixture({ holdInference: true });
  f.pauseHealth();
  const first = f.control("POST");
  await waitFor(signal, () => f.pendingHealth() === 1);
  const second = f.control("POST");
  await waitFor(signal, () => f.pendingHealth() === 2);
  f.releaseHealth();
  expect((await first).status).toBe(200);
  const inference = f.infer();
  await waitFor(signal, () => f.received.length === 1);
  f.releaseHealth();
  expect((await second).status).toBe(200);
  expect((await f.control("DELETE")).status).toBe(200);
  f.release();
  expect((await inference).status).toBe(403);
});

it("revoking an incomplete body immediately admits another attempt", async () => {
  const f = await fixture({ concurrency: "1" });
  expect((await f.control("POST")).status).toBe(200);
  const otherToken = randomBytes(32).toString("base64url");
  expect((await f.control("POST", { token: otherToken })).status).toBe(200);
  const arrived = once(f.inferenceServer, "request");
  const incomplete = httpRequest(
    `${f.inferenceUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        "content-length": "4096",
      },
    },
    (response) => response.resume(),
  );
  incomplete.on("error", () => {});
  onTestFinished(() => {
    incomplete.destroy();
  });
  incomplete.write('{"messages":[');
  await arrived;
  expect((await f.infer(undefined, otherToken)).status).toBe(429);
  expect((await f.control("DELETE")).status).toBe(200);
  expect((await f.infer(undefined, otherToken)).status).toBe(200);
});

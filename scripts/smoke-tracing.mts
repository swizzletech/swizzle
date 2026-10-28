// A private OTLP/HTTP collector for `just smoke`. It checks spans exported by the packaged
// processes, including their library instrumentation, rather than inspecting startup arguments.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { cleanUpOnSignal, throwawayPrefix } from "./packaged-stack.mts";

const execute = promisify(execFile);
// A published Docker port works even when the host firewall refuses native host listeners.
const COLLECTOR = `
  const { createServer } = await import("node:http");
  const exports = [];
  createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/exports") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(exports));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/traces") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      exports.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    } catch {
      response.writeHead(400).end();
    }
  }).listen(4318, "0.0.0.0");
`;

interface Span {
  readonly service: string;
  readonly scope: string;
  readonly name: string;
  readonly traceId: string;
  readonly runId: string | undefined;
  readonly route: string | undefined;
  readonly kind: number;
}

function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function attribute(value: unknown, key: string): string | undefined {
  for (const entry of array(value)) {
    const item = object(entry);
    if (item.key === key) {
      const text = object(item.value).stringValue;
      assert(typeof text === "string");
      return text;
    }
  }
  return undefined;
}

function decode(body: unknown): Span[] {
  const spans: Span[] = [];
  for (const resource of array(object(body).resourceSpans)) {
    const resourceSpans = object(resource);
    const service = attribute(object(resourceSpans.resource).attributes, "service.name");
    assert(service !== undefined);
    for (const scope of array(resourceSpans.scopeSpans)) {
      const scopeSpans = object(scope);
      const scopeName = object(scopeSpans.scope).name;
      assert(typeof scopeName === "string");
      for (const value of array(scopeSpans.spans)) {
        const span = object(value);
        assert(typeof span.name === "string" && typeof span.traceId === "string");
        spans.push({
          name: span.name,
          kind: Number(span.kind),
          route: attribute(span.attributes, "http.route"),
          runId: attribute(span.attributes, "automation.run_id"),
          scope: scopeName,
          service,
          traceId: span.traceId,
        });
      }
    }
  }
  return spans;
}

export interface SmokeTracing {
  readonly endpoint: string;
  assertWebhookTrace(runId: string): Promise<void>;
  close(): Promise<void>;
}

export async function startSmokeTracing(): Promise<SmokeTracing> {
  const project = `${throwawayPrefix("smoke")}${randomBytes(4).toString("hex")}`;
  const name = `${project}-collector`;
  let removal: Promise<void> | undefined;
  const close = () => {
    removal ??= execute("docker", ["rm", "--force", name]).then(() => undefined);
    return removal;
  };
  let port: string;
  try {
    await execute("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--label",
      `com.docker.compose.project=${project}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user",
      "65532:65532",
      "--memory=128m",
      "--pids-limit=32",
      "--publish",
      "0.0.0.0::4318",
      "node:26.12.1-alpine3.24",
      "--input-type=module",
      "-e",
      COLLECTOR,
    ]);
    cleanUpOnSignal(close);
    const { stdout } = await execute("docker", ["port", name, "4318/tcp"]);
    const match = /^0\.0\.0\.0:(\d+)$/u.exec(stdout.trim());
    assert(match?.[1]);
    port = match[1];
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return {
    endpoint: `http://host.docker.internal:${port}`,
    async assertWebhookTrace(runId) {
      const deadline = Date.now() + 30_000;
      let missing: string[] = [];
      let spans: Span[] = [];
      do {
        const response = await fetch(`http://127.0.0.1:${port}/exports`);
        assert(response.ok, `OTLP collector answered ${response.status}`);
        spans = array(await response.json()).flatMap(decode);
        const execution = spans.find(
          (span) =>
            span.service === "swizzle-worker" &&
            span.name === "automation.process" &&
            span.runId === runId,
        );
        const trace = spans.filter((span) => span.traceId === execution?.traceId);
        const required = [
          ["swizzle-api", "@opentelemetry/instrumentation-http"],
          ["swizzle-api", "@opentelemetry/instrumentation-pg"],
          ["swizzle-api", "@opentelemetry/instrumentation-ioredis"],
        ];
        missing = required
          .filter(
            ([service, scope]) =>
              !trace.some((span) => span.service === service && span.scope === scope),
          )
          .map(([service, scope]) => `${service} ${scope}`);
        if (!execution) missing.unshift("swizzle-worker automation.process");
        if (
          !trace.some(
            (span) =>
              span.service === "swizzle-api" &&
              span.name === "automation.complete" &&
              span.runId === runId,
          )
        )
          missing.push("swizzle-api automation.complete in the same trace");
        if (
          !trace.some(
            (span) =>
              span.service === "swizzle-api" &&
              span.scope === "@opentelemetry/instrumentation-http" &&
              span.kind === 2 &&
              span.route === "/hooks/*",
          )
        ) {
          missing.push('swizzle-api HTTP server span with http.route="/hooks/*"');
        }

        if (
          !spans.some(
            (span) =>
              span.service === "swizzle-scheduler" &&
              span.scope === "@opentelemetry/instrumentation-pg",
          )
        ) {
          missing.push("swizzle-scheduler @opentelemetry/instrumentation-pg");
        }
        if (missing.length === 0) {
          process.stdout.write(
            `smoke: webhook trace ${execution?.traceId} contains worker automation.process, API automation.complete, HTTP server http.route="/hooks/*", pg and ioredis spans; scheduler exports pg spans\n`,
          );
          return;
        }
        await delay(500);
      } while (Date.now() < deadline);
      throw new Error(
        `Tracing preload check failed for run ${runId}. Missing spans: ${missing.join(", ")}. Received ${spans.length} spans.`,
      );
    },
    close,
  };
}

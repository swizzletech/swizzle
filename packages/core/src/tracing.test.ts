import { expect, it, vi } from "vitest";

import { recordingProxy } from "../../../test/support.js";
import { shutdownTracing, startTracing, trace } from "./tracing.js";

it.each([undefined, "", "   "])("records no spans for the endpoint %j", async (endpoint) => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);

  await startTracing("test-service");

  expect(trace.getTracer("test").startSpan("probe").isRecording()).toBe(false);
});

it("exports spans through the control egress proxy", async () => {
  const proxy = await recordingProxy();
  vi.stubEnv("SWIZZLE_CONTROL_EGRESS_PROXY", proxy.url);
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.swizzle.invalid");

  await startTracing("test-service");
  trace.getTracer("test").startSpan("probe").end();
  await shutdownTracing();

  expect(proxy.requests).toContain("POST http://collector.swizzle.invalid/v1/traces");
});

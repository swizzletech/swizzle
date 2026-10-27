import { expect, it, vi } from "vitest";

import { recordingProxy } from "../../../test/support.js";
import { shutdownTracing, startTracing, trace } from "./tracing.js";

// Compose passes the endpoint through as an empty string when the operator leaves it unset.
it.each([undefined, "", "   "])("records no spans for the endpoint %j", async (endpoint) => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);

  await startTracing("test-service");

  expect(trace.getTracer("test").startSpan("probe").isRecording()).toBe(false);
});

// startTracing imports the OpenTelemetry SDK and its auto-instrumentations, up to 1.1 s of CPU. The
// budget lets a loaded host give it a tenth of a core.
it("exports spans through the control egress proxy", async () => {
  const proxy = await recordingProxy();
  vi.stubEnv("SWIZZLE_CONTROL_EGRESS_PROXY", proxy.url);
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.swizzle.invalid");

  await startTracing("test-service");
  trace.getTracer("test").startSpan("probe").end();
  await shutdownTracing();

  expect(proxy.requests).toContain("POST http://collector.swizzle.invalid/v1/traces");
}, 15_000);

/// <reference path="./import-in-the-middle.d.ts" />
// OpenTelemetry for the api, scheduler and worker. Each service starts it from a preload that
// node loads with `--import` before main.ts (apps/*/src/tracing.ts), so the instrumentations
// patch http, pg and ioredis before main.ts imports them. Started any later, those
// modules are already loaded and produce no spans.
// The SDK and its instrumentations load only when tracing starts: they take longer to import than
// the rest of the platform, and every importer of @swizzle/core would pay for them.

import { type Tracer, trace } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";

import { controlEgressAgentOptions, EgressProxyConfigurationError } from "./http-egress.js";
import { createLogger } from "./logger.js";
import { APP_VERSION } from "./version.js";

let sdk: NodeSDK | null = null;

/**
 * Validates the control proxy, then starts the SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * Traces go to `<endpoint>/v1/traces`, through the control proxy when one is configured.
 */
export async function startTracing(serviceName: string): Promise<void> {
  let agentOptions: ReturnType<typeof controlEgressAgentOptions>;
  try {
    agentOptions = controlEgressAgentOptions();
  } catch (error) {
    if (!(error instanceof EgressProxyConfigurationError)) throw error;
    createLogger(serviceName).fatal({ code: "EGRESS_PROXY_INVALID" }, error.message);
    process.exit(1);
  }
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;

  const [
    { getNodeAutoInstrumentations },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { NodeSDK },
    { ATTR_SERVICE_VERSION },
    { register },
  ] = await Promise.all([
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/semantic-conventions"),
    import("import-in-the-middle/register-hooks.mjs"),
  ]);

  // ESM imports bypass require(), so instrumentations see them only through this loader hook.
  // It runs in this thread through module.registerHooks and sees the Hook() calls the
  // instrumentations make through the same import-in-the-middle copy.
  register();
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_VERSION]: APP_VERSION }),
    // Set here, the name wins over OTEL_SERVICE_NAME, which would give every service one name.
    serviceName,
    // Traces only: without these the SDK also starts OTLP metric and log exporters from the
    // environment, which bypass the control egress proxy.
    logRecordProcessors: [],
    metricReaders: [],
    traceExporter: new OTLPTraceExporter({
      httpAgentOptions: { keepAlive: true, ...agentOptions },
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  createLogger(serviceName).info({ endpoint }, "OpenTelemetry tracing enabled.");
}

/** Flushes pending spans and stops the SDK; a no-op when tracing never started. */
export async function shutdownTracing(): Promise<void> {
  const started = sdk;
  sdk = null;
  await started?.shutdown();
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

export { trace } from "@opentelemetry/api";

/// <reference path="./import-in-the-middle.d.ts" />

import { type Tracer, trace } from "@opentelemetry/api";
import type { NodeSDK } from "@opentelemetry/sdk-node";

import { controlEgressAgentOptions, EgressProxyConfigurationError } from "./http-egress.js";
import { createLogger } from "./logger.js";
import { APP_VERSION } from "./version.js";

const TRACE_ONLY_SDK_OPTIONS = { logRecordProcessors: [], metricReaders: [] };

let sdk: NodeSDK | null = null;

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
    { register: registerEsmInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/semantic-conventions"),
    import("import-in-the-middle/register-hooks.mjs"),
  ]);

  registerEsmInstrumentation();
  sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_VERSION]: APP_VERSION }),
    serviceName,
    ...TRACE_ONLY_SDK_OPTIONS,
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

export async function shutdownTracing(): Promise<void> {
  const started = sdk;
  sdk = null;
  await started?.shutdown();
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

export { trace } from "@opentelemetry/api";

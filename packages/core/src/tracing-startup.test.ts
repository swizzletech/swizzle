import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { recordingProxy } from "../../../test/support.js";

it.each(["api", "worker"])(
  "%s tracing preload reports an invalid proxy as a named fatal",
  async (service) => {
    const result = await runNode(
      [
        "--import",
        "tsx",
        "--conditions=swizzle-source",
        "--import",
        `./apps/${service}/src/tracing.ts`,
        "-e",
        "",
      ],
      {
        NODE_ENV: "production",
        SWIZZLE_LOG_FILE: "",
        LOG_LEVEL: "info",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
        SWIZZLE_CONTROL_EGRESS_PROXY: "invalid-proxy",
      },
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain("EGRESS_PROXY_INVALID");
    expect(result.output).not.toMatch(/\n\s+at /u);
  },
);

it("tracing preload hooks ESM imports without a warning", async () => {
  const result = await runNode(
    [
      "--import",
      "tsx",
      "--conditions=swizzle-source",
      "--import",
      "./apps/api/src/tracing.ts",
      "--input-type=module",
      "-e",
      `const { createRequire } = await import("node:module");
        const { Hook } = createRequire(process.cwd() + "/packages/core/")("import-in-the-middle");
        let hooked = false;
        new Hook(["pg"], (exported) => { hooked = true; return exported; });
        await import("pg");
        console.log("pg hooked: " + hooked);`,
    ],
    {
      NODE_ENV: "production",
      SWIZZLE_LOG_FILE: "",
      LOG_LEVEL: "info",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
    },
  );
  expect(result.output).toContain("pg hooked: true");
  expect(result.output).not.toContain("Warning");
  expect(result.status).toBe(0);
});

it("exports only traces even when the environment enables log and metric exporters", async () => {
  const proxy = await recordingProxy();
  const collector = await recordingProxy();
  const result = await runNode(
    [
      "--import",
      "tsx",
      "--conditions=swizzle-source",
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module";
        import { shutdownTracing, startTracing, trace } from "@swizzle/core";
        const requireCore = createRequire(import.meta.resolve("@swizzle/core"));
        const { logs, metrics } = requireCore("@opentelemetry/api");
        await startTracing("test-service");
        logs.getLogger("probe").emit({ body: "log probe" });
        metrics.getMeter("probe").createCounter("probe").add(1);
        trace.getTracer("probe").startSpan("trace probe").end();
        await shutdownTracing();`,
    ],
    {
      NODE_ENV: "production",
      SWIZZLE_CONTROL_EGRESS_PROXY: proxy.url,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.swizzle.invalid",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${collector.url}/v1/logs`,
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${collector.url}/v1/metrics`,
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
    },
  );

  expect(result.status, result.output).toBe(0);
  expect(proxy.requests).toEqual(["POST http://collector.swizzle.invalid/v1/traces"]);
  expect(collector.requests).toEqual([]);
});

it.each(["api", "worker", "scheduler"])(
  "%s main reports invalid proxy configuration as a named fatal",
  async (service) => {
    const result = await runNode(
      ["--import", "tsx", "--conditions=swizzle-source", `./apps/${service}/src/main.ts`],
      {
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        SWIZZLE_LOG_FILE: "",
        SWIZZLE_CONTROL_EGRESS_PROXY: "https://proxy.example:3128",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      },
    );
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/FATAL|"level":60/u);
    expect(result.output).toContain("EGRESS_PROXY_INVALID");
    expect(result.output).not.toMatch(/\n\s+at |"stack":/u);
  },
);

async function runNode(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const [status] = await once(child, "close");
  return { status, output };
}

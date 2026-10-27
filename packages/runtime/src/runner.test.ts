import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import { runAutomation } from "./index.js";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(sourceRoot, "..");
const repoRoot = path.resolve(packageRoot, "../..");
const fixturesRoot = path.join(packageRoot, "test-fixtures");

describe("runAutomation", () => {
  it("runs the hello-webhook example and parses JSON stdout", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      inlineJson: '{"hello":"jan"}',
      runId: "local-run-test",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success, got ${result.code}: ${result.message}`);
    }

    expect(result.result).toMatchObject({
      message: "Hello from Swizzle",
      payload: { hello: "jan" },
      run_id: "local-run-test",
      trigger_type: "manual",
    });
  });

  it("uses an empty object when no payload is supplied", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      runId: "local-run-empty",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success, got ${result.code}: ${result.message}`);
    }

    expect(result.payload).toEqual({});
    expect(result.result).toMatchObject({
      payload: {},
    });
  });

  it("runs javascript and typescript entrypoints locally", async () => {
    const javascriptResult = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "javascript-success"),
    });
    const typescriptResult = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "typescript-success"),
    });

    expect(javascriptResult.success).toBe(true);
    expect(typescriptResult.success).toBe(true);

    if (!javascriptResult.success || !typescriptResult.success) {
      throw new Error("Expected javascript and typescript fixtures to run successfully.");
    }

    expect(javascriptResult.result).toEqual({ runtime: "js" });
    expect(typescriptResult.result).toEqual({ runtime: "ts" });
  });

  it("runs a TypeScript entrypoint with top-level await outside any package.json", async () => {
    const automationDirectory = await temporaryDirectory("swizzle-ts-esm-");
    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      "name: ts-esm\nversion: 1.0.0\nentrypoint: main.ts\ntrigger:\n  type: cron\n  schedule: '0 * * * *'\n",
    );
    await writeFile(
      path.join(automationDirectory, "main.ts"),
      'const runtime: string = await Promise.resolve("ts");\nconsole.log(JSON.stringify({ runtime }));\n',
    );

    const result = await runAutomation({ environmentName: "local", automationDirectory });

    expect(result).toMatchObject({ success: true, result: { runtime: "ts" } });
  });

  it("injects config vars as strings for local runs", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "vars-snapshot"),
      environment: {
        ENABLE_CREATE: "ambient",
        FEATURE_MODE: "ambient",
        MAX_ITEMS: "ambient",
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success, got ${result.code}: ${result.message}`);
    }

    expect(result.result).toEqual({
      enable_create: "false",
      feature_mode: "dry-run",
      max_items: "5",
    });
  });

  it("passes webhook headers and raw body through additive runtime metadata", async () => {
    const rawBody = Buffer.from('{\n  "hello": "jan"\n}');
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "webhook-context"),
      inlineJson: '{"hello":"jan"}',
      runId: "local-run-webhook-context",
      webhookContext: {
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=123,v1=signature",
        },
        rawBodyBase64: rawBody.toString("base64"),
        rawBodyByteLength: rawBody.byteLength,
        rawBodySha256: createHash("sha256").update(rawBody).digest("hex"),
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(`Expected success, got ${result.code}: ${result.message}`);
    }

    expect(result.payload).toEqual({ hello: "jan" });
    expect(result.result).toMatchObject({
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=signature",
      },
      payload: { hello: "jan" },
      raw_body: '{\n  "hello": "jan"\n}',
    });
    expect((result.result as { raw_body_sha256: string }).raw_body_sha256).toBe(
      (result.result as { raw_body_sha256_env: string }).raw_body_sha256_env,
    );
  });

  it("validates local webhook payloads against trigger.payload_schema before execution", async () => {
    const invalid = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "webhook-payload-schema"),
      inlineJson: '{"amount":42}',
    });

    expect(invalid.success).toBe(false);
    if (invalid.success) {
      throw new Error("Expected payload schema validation to fail.");
    }

    expect(invalid.code).toBe("WEBHOOK_PAYLOAD_INVALID");
    expect(invalid.message).toContain("trigger.payload_schema");

    const valid = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "webhook-payload-schema"),
      inlineJson: '{"event":"invoice.created","amount":42}',
    });

    expect(valid.success).toBe(true);
    if (!valid.success) {
      throw new Error(`Expected success, got ${valid.code}: ${valid.message}`);
    }

    expect(valid.result).toEqual({
      accepted: true,
      payload: {
        amount: 42,
        event: "invoice.created",
      },
    });
  });

  it("runs SDK-backed python and typescript examples through the existing runtime contract", async () => {
    const pythonResult = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/document-scanner"),
      filePath: path.join(repoRoot, "infra/examples/document-scanner/sample-payload.json"),
    });
    const typescriptResult = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/typescript-webhook"),
      filePath: path.join(repoRoot, "infra/examples/typescript-webhook/sample-payload.json"),
    });

    expect(pythonResult.success).toBe(true);
    expect(typescriptResult.success).toBe(true);

    if (!pythonResult.success || !typescriptResult.success) {
      throw new Error("Expected SDK-backed python and typescript examples to run successfully.");
    }

    expect(pythonResult.result).toMatchObject({
      scan: {
        document_id: "doc-1001",
      },
      status: "ok",
    });
    expect(pythonResult.stderr).toContain('"type": "step"');
    expect(typescriptResult.result).toMatchObject({
      normalized: {
        event: "invoice.created",
      },
      status: "ok",
    });
    expect(typescriptResult.stderr).toContain('"type":"step"');
  });

  it("fails when required secrets are missing", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "requires-secret"),
      environment: {},
    });

    expect(result).toMatchObject({
      code: "MISSING_REQUIRED_SECRETS",
      success: false,
    });
  });

  it("refuses to execute when runtime.timeout exceeds the platform ceiling", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "timeout-exceeds-platform-max"),
      policyEnvironment: {
        SWIZZLE_MAX_RUN_TIMEOUT: "1h",
      },
    });

    expect(result).toMatchObject({
      code: "RUNTIME_TIMEOUT_EXCEEDS_MAX",
      success: false,
    });
    expect(result.stdout).toBe("");
  });

  it("fails when inline payload JSON is invalid", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      inlineJson: "{not-json}",
    });

    expect(result).toMatchObject({
      code: "INVALID_PAYLOAD_JSON",
      success: false,
    });
  });

  it("fails when payload file JSON is invalid", async () => {
    const directory = await temporaryDirectory("swizzle-runtime-");

    const payloadFilePath = path.join(directory, "payload.json");
    await writeFile(payloadFilePath, "{broken", "utf8");

    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(repoRoot, "infra/examples/hello-webhook"),
      filePath: payloadFilePath,
    });

    expect(result).toMatchObject({
      code: "INVALID_PAYLOAD_FILE_JSON",
      success: false,
    });
  });

  it("fails when the automation exits with a non-zero status", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "failing-run"),
    });

    expect(result).toMatchObject({
      code: "PROCESS_EXIT_NON_ZERO",
      success: false,
    });
    expect(result.stderr).toContain("runner log");
  });

  it("fails when stdout is empty", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "empty-stdout"),
    });

    expect(result).toMatchObject({
      code: "PROCESS_STDOUT_EMPTY",
      success: false,
    });
  });

  it("fails when stdout is not valid JSON", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "invalid-json-output"),
    });

    expect(result).toMatchObject({
      code: "PROCESS_STDOUT_INVALID_JSON",
      success: false,
    });
  });

  it("keeps a complete UTF-8 prefix when the local output limit splits a character", async () => {
    const automationDirectory = await createAutomationFixture({
      name: "utf8-output",
      triggerLines: ["  type: webhook"],
      mainJs: `process.on("SIGTERM", () => { process.stdout.write("b"); process.exit(0); });
process.stdout.write("aé");
setInterval(() => {}, 1000);`,
    });
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory,
      outputLimitBytes: 2,
    });
    expect(result).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      stdout: "a",
    });
  });

  it("fails and truncates captured stdout when stdout exceeds the output limit", async () => {
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "large-stdout"),
      outputLimitBytes: 128,
    });

    expect(result).toMatchObject({
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      success: false,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(128);
  });

  it("fails and truncates streamed stderr when stderr exceeds the output limit", async () => {
    let streamedStderr = "";
    const result = await runAutomation({
      environmentName: "local",
      automationDirectory: path.join(fixturesRoot, "large-stderr"),
      onStderrChunk: (chunk) => {
        streamedStderr += chunk;
      },
      outputLimitBytes: 128,
    });

    expect(result).toMatchObject({
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      success: false,
    });
    expect(result.stderr.length).toBeLessThanOrEqual(128);
    expect(streamedStderr.length).toBeLessThanOrEqual(128);
  });
});

it("awaits output persistence before returning a completed execution", async () => {
  const automationDirectory = await createAutomationFixture({
    name: "async-output",
    triggerLines: ["  type: webhook", "  path: /output"],
    mainJs: "process.stderr.write('log'); console.log('{}');",
  });
  const chunks: string[] = [];
  const result = await runAutomation({
    automationDirectory,
    environmentName: "local",
    onStderrChunk: async (chunk) => {
      await delay(50);
      chunks.push(chunk);
    },
    onStdoutChunk: async (chunk) => {
      await delay(50);
      chunks.push(chunk);
    },
  });
  expect(result.success).toBe(true);
  expect(chunks.join("")).toContain("log");
  expect(chunks.join("")).toContain("{}");
  const failed = await runAutomation({
    automationDirectory,
    environmentName: "local",
    onStdoutChunk: async () => {
      await delay(10);
      throw new Error("output write failed");
    },
  });
  expect(failed).toMatchObject({ success: false, message: "output write failed" });
});

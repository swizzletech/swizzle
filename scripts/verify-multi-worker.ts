import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import {
  createDashboardStore,
  createPostgresControlPlaneStore,
  createPostgresWorkerRegistry,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { collectWorkerCapabilities } from "@swizzle/runtime";
import {
  createPlatformServices,
  type PlatformLogger,
  type PlatformServices,
  startPlatformWorkerService,
} from "@swizzle/runtime/platform";
import { withVerificationDatabase } from "./verification-database.js";
import { startVerificationApi } from "./verify-api-process.js";

import { verifyRetryRecovery } from "./verify-retry-recovery.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const environmentName = "multi-worker-smoke";
process.env.SWIZZLE_ENCRYPTION_KEY ??= "12345678901234567890123456789012";
const logger: PlatformLogger = {
  debug() {},
  error(...args) {
    process.stderr.write(`${formatLogLine(args)}\n`);
  },
  info() {},
  warn(...args) {
    process.stderr.write(`${formatLogLine(args)}\n`);
  },
};

// The platform logs pino-style: an object of fields or an error, then the message. Print the
// message first, then each field as key=value, an error as its message.
function formatLogLine(args: readonly unknown[]): string {
  const [first, ...rest] = args;
  const fields =
    typeof first === "object" && first !== null && !(first instanceof Error)
      ? Object.entries(first)
      : [];
  const message = fields.length > 0 ? rest : args;
  return [
    ...message.map(formatLogValue),
    ...fields.map(([key, value]) => `${key}=${formatLogValue(value)}`),
  ].join(" ");
}

function formatLogValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function main(client: DatabaseClient): Promise<void> {
  const smokeProfile = `multi-worker-smoke-${process.pid}`;
  const cleanups: (() => Promise<unknown>)[] = [];
  const failures: unknown[] = [];
  try {
    const artifactsDirectory = await mkdtemp(
      path.join(os.tmpdir(), "swizzle-multi-worker-artifacts-"),
    );
    cleanups.push(() => rm(artifactsDirectory, { force: true, recursive: true }));
    // The workers resolve artifacts from the environment; point them at this run's directory,
    // not at the SWIZZLE_ARTIFACTS_DIR the caller's .env carries.
    process.env.SWIZZLE_ARTIFACTS_DIR = artifactsDirectory;
    const automationDirectory = await createIsolatedAutomationFixture(smokeProfile);
    cleanups.push(() => rm(automationDirectory, { force: true, recursive: true }));
    const dashboardStore = createDashboardStore({ client });
    cleanups.push(() => dashboardStore.close());
    const registry = createPostgresWorkerRegistry({ client });
    cleanups.push(() => registry.close());
    const platform = await createPlatformServices({
      artifactsDirectory,
      store: createPostgresControlPlaneStore({ client }),
      dashboardStore,
      workerRegistry: registry,
    });
    cleanups.push(() => platform.close());
    const invocationId = randomUUID();
    const workerInstanceIds: readonly [string, string] = [
      `multi-worker-a-${process.pid}-${invocationId}`,
      `multi-worker-b-${process.pid}-${invocationId}`,
    ];
    const capabilities = await collectWorkerCapabilities([]);
    const api = await startVerificationApi();
    cleanups.push(() => api.close());
    const credentials = await Promise.all(
      workerInstanceIds.map(async (name) => {
        const enrollment = await registry.create({
          name,
          services: [],
          profiles: [smokeProfile],
          capacity: 1,
          issuedBy: null,
          environments: [environmentName, "local"].map((environment) => ({
            projectId: DEFAULT_PROJECT_ID,
            environment,
          })),
        });
        return await registry.enroll(enrollment.code, name);
      }),
    );
    const credentialA = credentials[0];
    const credentialB = credentials[1];
    if (credentialA === undefined || credentialB === undefined)
      throw new Error("Missing verification worker credentials.");
    const workerA = await startPlatformWorkerService({
      apiUrl: api.url,
      credential: { kind: "configured", token: credentialA.token },
      capabilities,
      concurrency: 1,
      logger,
    });
    cleanups.push(() => workerA.close());
    const workerB = await startPlatformWorkerService({
      apiUrl: api.url,
      credential: { kind: "configured", token: credentialB.token },
      capabilities,
      concurrency: 1,
      logger,
    });

    cleanups.push(() => workerB.close());
    await platform.deployAutomationToPlatform({
      automationDirectory,
      environment: environmentName,
    });

    const runIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const runId = randomUUID();
      runIds.push(runId);
      await platform.enqueuePlatformRun({
        automationName: "hello-webhook",
        environment: environmentName,
        payload: { index },
        runId,
      });
    }

    await waitForRuns(platform, runIds, 20_000);

    const completedRuns = await Promise.all(runIds.map((runId) => platform.getPlatformRun(runId)));
    if (new Set(completedRuns.map((run) => run.runId)).size !== runIds.length) {
      throw new Error("Expected unique run IDs after multi-worker processing.");
    }
    if (
      completedRuns.some(
        (run) =>
          run.status !== "succeeded" || run.attemptsMade !== 1 || run.executions.length !== 1,
      )
    ) {
      throw new Error("Expected every multi-worker smoke run to succeed exactly once.");
    }

    const workerHeartbeats = (await registry.list()).filter(
      (worker) =>
        workerInstanceIds.includes(worker.name) &&
        worker.state === "online" &&
        worker.capabilities !== null,
    );
    if (workerHeartbeats.length !== 2) {
      throw new Error(
        `Expected both workers online with capabilities: ${workerInstanceIds.join(", ")}.`,
      );
    }

    // Suspend/resume smoke: parent invokes a child through the real BullMQ
    // path. This is the only verification that exercises resume job ids
    // against actual BullMQ (the in-memory queue accepts ids BullMQ rejects).
    const resumeFixtures = await createResumeFixtures(smokeProfile);
    try {
      await platform.deployAutomationToPlatform({
        automationDirectory: resumeFixtures.childDirectory,
        environment: environmentName,
      });
      await platform.deployAutomationToPlatform({
        automationDirectory: resumeFixtures.parentDirectory,
        environment: environmentName,
      });
      const parentRunId = randomUUID();
      await platform.enqueuePlatformRun({
        automationName: "resume-parent",
        environment: environmentName,
        payload: {},
        runId: parentRunId,
      });
      await waitForRuns(platform, [parentRunId], 20_000);

      const parentRun = await platform.getPlatformRun(parentRunId);
      if (parentRun.resumeCount !== 1) {
        throw new Error(`Expected parent resumeCount 1, got ${parentRun.resumeCount}.`);
      }
      const executionStatuses = parentRun.executions.map((execution) => execution.status);
      if (executionStatuses.join(",") !== "suspended,succeeded") {
        throw new Error(`Expected executions [suspended, succeeded], got [${executionStatuses}].`);
      }
      // The parent's stdout JSON, so its shape is whatever the fixture above prints.
      const parentResult = parentRun.result as { child?: { result?: { ok?: unknown } } } | null;
      if (parentResult?.child?.result?.ok !== true) {
        throw new Error("Expected the parent result to contain the child envelope.");
      }
    } finally {
      await Promise.all([
        rm(resumeFixtures.parentDirectory, { force: true, recursive: true }),
        rm(resumeFixtures.childDirectory, { force: true, recursive: true }),
      ]);
    }

    await verifyRetryRecovery(platform, smokeProfile);

    process.stdout.write(
      `Multi-worker verification passed with ${completedRuns.length} runs, one suspend/resume round-trip, and ${workerHeartbeats.length} worker heartbeats (${workerInstanceIds.join(", ")}).\n`,
    );
  } finally {
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Multi-worker cleanup failed.");
}

async function createIsolatedAutomationFixture(profileName: string): Promise<string> {
  const sourceDirectory = path.join(repoRoot, "infra/examples/hello-webhook");
  const automationDirectory = await mkdtemp(
    path.join(os.tmpdir(), "swizzle-multi-worker-automation-"),
  );
  await cp(sourceDirectory, automationDirectory, { recursive: true });

  const configPath = path.join(automationDirectory, "config.yaml");
  const config = await readFile(configPath, "utf8");
  const updatedConfig = config.replace("profile: host-default", `profile: ${profileName}`);
  if (updatedConfig === config) {
    throw new Error("Failed to patch hello-webhook profile for multi-worker verification.");
  }

  await writeFile(configPath, updatedConfig, "utf8");
  return automationDirectory;
}

async function createResumeFixtures(
  profileName: string,
): Promise<{ childDirectory: string; parentDirectory: string }> {
  const childDirectory = await mkdtemp(path.join(os.tmpdir(), "swizzle-resume-child-"));
  await writeFile(
    path.join(childDirectory, "config.yaml"),
    [
      "name: resume-child",
      "version: 1.0.0",
      "entrypoint: main.js",
      "trigger:",
      "  type: webhook",
      "  path: /resume-child",
      "runtime:",
      `  profile: ${profileName}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(childDirectory, "main.js"),
    'process.stdout.write(JSON.stringify({ ok: true }) + "\\n");\n',
    "utf8",
  );

  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "swizzle-resume-parent-"));
  await writeFile(
    path.join(parentDirectory, "config.yaml"),
    [
      "name: resume-parent",
      "version: 1.0.0",
      "entrypoint: main.js",
      "trigger:",
      "  type: webhook",
      "  path: /resume-parent",
      "runtime:",
      `  profile: ${profileName}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(parentDirectory, "main.js"),
    [
      'const fs = require("node:fs");',
      'const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, "utf8"));',
      'if (steps["invoke-child"] === undefined) {',
      "  process.stdout.write(",
      '    JSON.stringify({ $swizzle: { suspend: { reason: "child", stepKey: "invoke-child", automation: "resume-child", payload: {} } } }) + "\\n",',
      "  );",
      "  process.exit(0);",
      "}",
      'process.stdout.write(JSON.stringify({ status: "ok", child: steps["invoke-child"] }) + "\\n");',
      "",
    ].join("\n"),
    "utf8",
  );

  return { childDirectory, parentDirectory };
}

async function waitForRuns(
  platform: PlatformServices,
  runIds: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const runs = await Promise.all(runIds.map((runId) => platform.getPlatformRun(runId)));
    if (runs.every((run) => run.status === "succeeded")) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out while waiting for ${runIds.length} runs to finish.`);
}

withVerificationDatabase(main).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});

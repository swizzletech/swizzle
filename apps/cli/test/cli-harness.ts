import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardStore, createPostgresWorkerRegistry } from "@swizzle/db/postgres";
import type {
  DeploymentSummaryResponse,
  JudgedAutomationSummary,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import { Queue } from "bullmq";
import { beforeEach, vi } from "vitest";
import {
  type DashboardSecretStatus,
  type DashboardTriggerSummary,
  DEFAULT_PROJECT_ID,
} from "../../../packages/db/src/index.js";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { temporaryDirectory } from "../../../test/support.js";
import {
  createDashboardDataProvider,
  type DashboardDataProvider,
} from "../../api/src/dashboard.js";
import { ownerToken } from "../../api/test/people.js";
import { saveProfileConfig } from "../src/profile.js";

export { OWNER_TOKEN, ownerToken, testPeople } from "../../api/test/people.js";
export { buildTestServer } from "../../api/test/server-harness.js";

export const appRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const repoRoot = path.resolve(appRoot, "../..");
export const fixturesRoot = path.join(repoRoot, "packages/runtime/test-fixtures");

export function useCliTestEnvironment(): void {
  beforeEach(async () => {
    const env = { SWIZZLE_CONFIG_HOME: await temporaryDirectory("swizzle-cli-config-") };
    const owner = { name: "owner", token: await ownerToken(), url: "http://127.0.0.1:1" };
    await saveProfileConfig({ defaultProfile: owner.name, profiles: { owner } }, env);
    vi.stubEnv("SWIZZLE_CONFIG_HOME", env.SWIZZLE_CONFIG_HOME);
    vi.stubEnv("SWIZZLE_ENVIRONMENT", "local");
  });
}

export async function withoutProfile(): Promise<void> {
  vi.stubEnv("SWIZZLE_CONFIG_HOME", await temporaryDirectory("swizzle-cli-no-profile-"));
}

export async function createPlatformForStub(automationSlug: string): Promise<PlatformServices> {
  const platform = await testPlatform();
  platform.findAutomation = async (name) =>
    name === automationSlug
      ? { automationId: "stub-id", automationSlug, projectId: DEFAULT_PROJECT_ID }
      : null;
  return platform;
}

export function dashboardWithStoredRuns(platform: PlatformServices): DashboardDataProvider {
  vi.spyOn(Queue.prototype, "getJobCounts").mockRejectedValue(new Error("no Valkey"));
  const client = testDatabase();
  return createDashboardDataProvider({
    dashboardStore: createDashboardStore({ client }),
    platform,
    workerRegistry: createPostgresWorkerRegistry({ client }),
  });
}

export function createDashboardStub(
  automationSlug: string,
  triggerType: DashboardTriggerSummary["triggerType"] = "webhook",
): DashboardDataProvider {
  const at = "2026-04-18T22:00:00.000Z";
  const activeDeployment: DeploymentSummaryResponse = {
    artifactBackend: "local",
    artifactLocator: {
      artifactsDirectory: "/artifacts",
      relativeRootPath: "dep-active",
      type: "local",
    },
    artifactRootPath: "/artifacts/dep-active",
    buildSnapshot: { stepSites: [], packagedAt: at, status: "not-required", steps: [] },
    deployedAt: at,
    deploymentId: "dep-active",
    entrypoint: "main.ts",
    environment: "local",
    manifestPath: "/artifacts/dep-active/config.yaml",
    readiness: {
      availableProfiles: ["host-default"],
      checkedAt: at,
      compatibleWorkerInstanceIds: [],
      errors: [],
      executionMode: "host",
      language: "typescript",
      matchingWorkerCount: 0,
      profile: "host-default",
      queueName: "platform-runs--host-default",
      status: "ready",
      warnings: [],
    },
    runtimeSnapshot: {
      execution_mode: "host",
      language: "typescript",
      on_overlap: "queue",
      permissions: { network: true, writable_dirs: [], services: [] },
      profile: "host-default",
      rate_limits: {},
      requirements: { binaries: [] },
      retry: { backoff: "exponential", max_attempts: 3 },
      queue_timeout: "24h",
      timeout: "60s",
    },
    seq: 1,
    sourceDirectory: "/src",
    sourceHash: "abc123def456",
    status: "active",
    triggerType,
    vars: {},
    version: "1.0.0",
    versionId: "ver-1",
  };
  const secret = (name: string, present: boolean): DashboardSecretStatus => ({
    algorithm: null,
    createdAt: null,
    environment: "local",
    keyVersion: null,
    name,
    secretVersion: null,
    state: present ? "bound" : "missing",
    updatedAt: null,
  });
  const automation: JudgedAutomationSummary = {
    activeDeployment,
    apiCheck: null,
    apiContacts: [],
    automationId: "stub-id",
    automationName: automationSlug,
    automationSlug,
    description: null,
    environment: "local",
    invokesAutomationSlugs: [],
    folderId: null,
    folderName: null,
    lastRun: null,
    projectId: DEFAULT_PROJECT_ID,
    project: { id: DEFAULT_PROJECT_ID, slug: "default", name: "Default" },
    recentRuns: [
      {
        errorCode: null,
        errorMessage: null,
        queuedAt: at,
        runId: "run-1",
        state: "succeeded",
        status: "succeeded",
        triggerType: "manual",
      },
    ],
    requiredConnections: [],
    requiredSecrets: [secret("CLICKUP_TOKEN", true), secret("LEXOFFICE_API_KEY", false)],
    trigger: {
      chainHiddenSourceCount: 0,
      chainOnStatus: null,
      chainPayloadMode: null,
      chainSourceAutomationNames: [],
      chainSourceAutomationSlugs: [],
      cronIntervalMs: null,
      cronSchedule: triggerType === "cron" ? "*/5 * * * *" : null,
      deploymentId: "dep-active",
      environment: "local",
      errorCode: null,
      errorMessage: null,
      pausedAt: null,
      status: "active",
      triggerId: "trigger-1",
      ...(triggerType === "cron" ? { triggerType, nextRun: null } : { triggerType }),
      updatedAt: at,
      versionId: "ver-1",
      webhookPath: triggerType === "webhook" ? "/hooks/hello" : null,
    },
  };
  const counts = { active: 0, completed: 0, delayed: 0, failed: 0, waiting: 0 };
  const unused = async (): Promise<never> => {
    throw new Error("Not used by the CLI tests.");
  };
  return {
    close: async () => {},
    getAutomationDetail: async () => ({
      ...automation,
      deploymentAudit: [],
      deploymentHistory: [activeDeployment],
    }),
    getAutomationReadme: unused,
    getAutomationSource: unused,
    getMermaidDiagram: unused,
    getStepReach: unused,
    getOperabilitySummary: unused,
    getOverview: unused,
    getOperationsSummary: async () => ({
      automationCount: 1,
      environment: "local",
      maintenance: { latestRun: null, staleAfterMs: 300_000, state: "missing" },
      notifications: { deliveries: [], failed: 0, sent: 0, skipped: 0 },
      observedAt: at,
      onlineWorkers: 0,
      queue: { counts, name: "platform-runs", queues: [], recentSamples: [] },
      runStatusCounts: {
        "dead-lettered": 0,
        failed: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
        waiting: 0,
      },
      services: { heartbeatTtlMs: 30_000, instances: [], summary: [] },
      state: "healthy",
      stateReasons: [],
      triggerStatusCounts: { active: 1, invalid: 0, missing: 0, paused: 0 },
    }),
    listAutomations: async () => [automation],
    listRuns: unused,
    listRunSteps: unused,
  };
}

export async function createDeadApiUrl(): Promise<string> {
  const server = createServer();
  const url = await listenOnRandomPort(server);
  await closeServer(server);
  return url;
}

export async function listenOnRandomPort(server: ReturnType<typeof createServer>): Promise<string> {
  return await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const info = server.address();
      resolve(`http://127.0.0.1:${typeof info === "object" && info ? info.port : 0}`);
    });
  });
}

export async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createBufferIO() {
  let stdoutText = "";
  let stderrText = "";

  return {
    stderr: (message: string) => {
      stderrText += message;
    },
    stdout: (message: string) => {
      stdoutText += message;
    },
    get stderrText() {
      return stderrText;
    },
    get stdoutText() {
      return stdoutText;
    },
  };
}

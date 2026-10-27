#!/usr/bin/env node
import { runAutomation } from "./swizzle-sdk.ts";

type WorkspaceArtifact = {
  readonly repoUrl?: string;
  readonly baseBranch?: string;
  readonly specRef?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly branch?: string;
  readonly sha?: string;
  readonly summary?: {
    readonly filesChanged?: readonly string[];
    readonly notes?: readonly string[];
  };
};

type CheckResult = {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
};

type E2eResult = WorkspaceArtifact & {
  readonly verdict: "pass" | "fail";
  readonly checks: readonly CheckResult[];
};

await runAutomation<WorkspaceArtifact, E2eResult>(async ({ payload, logStep }) => {
  const checks = verifyWorkspace(payload);

  logStep("ran deterministic e2e checks", {
    checkCount: checks.length,
    failed: checks.filter((check) => !check.passed).map((check) => check.name),
    specRef: payload.specRef ?? null,
  });

  return {
    ...payload,
    checks,
    verdict: checks.every((check) => check.passed) ? "pass" : "fail",
  };
});

function verifyWorkspace(workspace: WorkspaceArtifact): CheckResult[] {
  const filesChanged = workspace.summary?.filesChanged ?? [];

  return [
    {
      detail: "The verifier can locate the decision-complete spec artifact.",
      name: "spec-reference-preserved",
      passed: typeof workspace.specRef === "string" && workspace.specRef.length > 0,
    },
    {
      detail: "The simulated workspace includes an implementation file.",
      name: "implementation-file-present",
      passed: filesChanged.some((file) => file.startsWith("src/")),
    },
    {
      detail: "The simulated workspace includes a test file.",
      name: "test-file-present",
      passed: filesChanged.some((file) => file.includes("test")),
    },
    {
      detail: "The branch and SHA can be re-fetched by a fresh verifier stage.",
      name: "durable-workspace-pointer",
      passed:
        typeof workspace.repoUrl === "string" &&
        workspace.repoUrl.length > 0 &&
        typeof workspace.baseBranch === "string" &&
        workspace.baseBranch.length > 0 &&
        typeof workspace.branch === "string" &&
        workspace.branch.startsWith("agent/") &&
        typeof workspace.sha === "string" &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.sha),
    },
    {
      detail: "Pipeline options remain available to a replacement verifier.",
      name: "options-preserved",
      passed: isRecord(workspace.options) && !Array.isArray(workspace.options),
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

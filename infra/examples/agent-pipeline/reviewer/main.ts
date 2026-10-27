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

type ReviewResult = WorkspaceArtifact & {
  readonly verdict: "pass" | "fail";
  readonly findings: readonly string[];
};

await runAutomation<WorkspaceArtifact, ReviewResult>(async ({ payload, logStep }) => {
  const findings = reviewWorkspace(payload);

  logStep("reviewed workspace handoff", {
    findingCount: findings.length,
    specRef: payload.specRef ?? null,
  });

  return {
    ...payload,
    findings,
    verdict: findings.length === 0 ? "pass" : "fail",
  };
});

function reviewWorkspace(workspace: WorkspaceArtifact): string[] {
  const findings: string[] = [];

  for (const field of ["repoUrl", "baseBranch", "specRef"] as const) {
    if (typeof workspace[field] !== "string" || workspace[field].trim().length === 0) {
      findings.push(`Missing ${field} in workspace handoff.`);
    }
  }
  if (!isRecord(workspace.options) || Array.isArray(workspace.options)) {
    findings.push("Workspace handoff must preserve options as an object.");
  }
  if (typeof workspace.branch !== "string" || !workspace.branch.startsWith("agent/")) {
    findings.push("Workspace branch must be a durable agent/* branch.");
  }
  if (typeof workspace.sha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.sha)) {
    findings.push("Workspace sha must be a 40- or 64-character Git object ID.");
  }
  if ((workspace.summary?.filesChanged ?? []).length === 0) {
    findings.push("Workspace summary should list representative changed files.");
  }

  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

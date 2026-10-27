#!/usr/bin/env node
import { runAutomation } from "./swizzle-sdk.ts";

type WorkspacePointer = {
  readonly repoUrl?: string;
  readonly baseBranch?: string;
  readonly specRef?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly branch?: string;
  readonly sha?: string;
};

type VerificationResult = WorkspacePointer & {
  readonly verdict?: "pass" | "fail";
  readonly findings?: readonly string[];
  readonly checks?: readonly {
    readonly name?: string;
    readonly passed?: boolean;
    readonly detail?: string;
  }[];
};

type JoinPayload = {
  readonly origin?: {
    readonly automation?: string;
    readonly runId?: string;
  };
  readonly results?: Readonly<Record<string, VerificationResult>>;
};

type TriageReport = {
  readonly repoUrl: string | null;
  readonly baseBranch: string | null;
  readonly specRef: string | null;
  readonly options: Readonly<Record<string, unknown>>;
  readonly branch: string | null;
  readonly sha: string | null;
  readonly origin: {
    readonly automation: string | null;
    readonly runId: string | null;
  };
  readonly decision: "ship" | "needs-work";
  readonly findings: readonly string[];
};

await runAutomation<JoinPayload, TriageReport>(async ({ payload, logStep }) => {
  const results = Object.entries(payload.results ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const workspace = results[0]?.[1] ?? {};
  const findings = collectFindings(results);
  const decision =
    results.length > 0 &&
    results.every(([, result]) => result.verdict === "pass") &&
    findings.length === 0
      ? "ship"
      : "needs-work";

  logStep("joined verification results", {
    decision,
    origin: payload.origin ?? null,
    resultSources: results.map(([source]) => source),
    workspace: pickWorkspacePointer(workspace),
  });

  return {
    ...pickWorkspacePointer(workspace),
    decision,
    findings,
    origin: {
      automation: payload.origin?.automation ?? null,
      runId: payload.origin?.runId ?? null,
    },
  };
});

function collectFindings(results: readonly [string, VerificationResult][]): string[] {
  if (results.length === 0) {
    return ["Join payload contains no verification results."];
  }

  const findings: string[] = [];
  const reference = results[0]?.[1] ?? {};

  for (const [source, result] of results) {
    findings.push(...validateWorkspacePointer(result).map((finding) => `${source}: ${finding}`));
    if (!sameWorkspace(reference, result)) {
      findings.push(`${source}: result does not point to the same workspace as its peers.`);
    }

    const failedChecks = (result.checks ?? [])
      .filter((check) => !check.passed)
      .map((check) => `${check.name ?? "unnamed-check"}: ${check.detail ?? "check failed"}`);
    findings.push(...failedChecks.map((finding) => `${source}: ${finding}`));

    if (result.verdict !== "pass") {
      const sourceFindings = result.findings ?? [];
      findings.push(...sourceFindings.map((finding) => `${source}: ${finding}`));
      if (sourceFindings.length === 0 && failedChecks.length === 0) {
        findings.push(`${source}: verification did not pass.`);
      }
    }
  }

  return findings;
}

function sameWorkspace(left: WorkspacePointer, right: WorkspacePointer): boolean {
  const coordinatesMatch = ["repoUrl", "baseBranch", "specRef", "branch", "sha"].every(
    (field) => left[field as keyof WorkspacePointer] === right[field as keyof WorkspacePointer],
  );
  return (
    coordinatesMatch && stableStringify(left.options ?? {}) === stableStringify(right.options ?? {})
  );
}

function validateWorkspacePointer(workspace: WorkspacePointer): string[] {
  const findings: string[] = [];
  for (const field of ["repoUrl", "baseBranch", "specRef", "branch", "sha"] as const) {
    if (typeof workspace[field] !== "string" || workspace[field].length === 0) {
      findings.push(`joined result is missing workspace field ${field}.`);
    }
  }
  if (!isRecord(workspace.options) || Array.isArray(workspace.options)) {
    findings.push("joined result is missing the options object.");
  }
  return findings;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value) ?? "null";
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickWorkspacePointer(
  workspace: WorkspacePointer,
): Pick<TriageReport, "repoUrl" | "baseBranch" | "specRef" | "options" | "branch" | "sha"> {
  return {
    baseBranch: workspace.baseBranch ?? null,
    branch: workspace.branch ?? null,
    options: workspace.options ?? {},
    repoUrl: workspace.repoUrl ?? null,
    sha: workspace.sha ?? null,
    specRef: workspace.specRef ?? null,
  };
}

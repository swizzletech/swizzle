#!/usr/bin/env node
import { createHash } from "node:crypto";

import { runAutomation, runStep } from "./swizzle-sdk.ts";

type WorkOrder = {
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly specRef: string;
  readonly options: Readonly<Record<string, unknown>>;
};

type WorkspaceArtifact = WorkOrder & {
  readonly branch: string;
  readonly sha: string;
  readonly summary: {
    readonly filesChanged: readonly string[];
    readonly notes: readonly string[];
  };
};

await runAutomation<WorkOrder, WorkspaceArtifact>(async ({ payload, logStep }) => {
  assertWorkOrder(payload);

  logStep("received work-order handoff", {
    baseBranch: payload.baseBranch,
    repoUrl: payload.repoUrl,
    specRef: payload.specRef,
  });

  /*
   * Real headless-agent swap point:
   * Replace only this runStep body with the clone -> agent -> commit -> push
   * flow in PLAYBOOK.md and the agent pipeline recipe. Keep returning the
   * complete work-order envelope plus { branch, sha, summary }. Do not return
   * worker-local checkout paths or session transcripts across this boundary.
   */
  return await runStep("build-workspace", async () => {
    const workId = hashJson(payload).slice(0, 12);

    return {
      ...payload,
      branch: `agent/work-${workId}`,
      sha: hashJson({ payload, syntheticBuild: true }),
      summary: {
        filesChanged: ["src/feature.ts", "src/routes.ts", "tests/feature.test.ts"],
        notes: [
          `Synthetic build generated from ${payload.specRef}`,
          "Swap the runStep body for a headless agent session when connected to a real repository",
        ],
      },
    };
  });
});

function assertWorkOrder(value: WorkOrder): void {
  if (!isRecord(value)) {
    throw new Error("builder expected a work-order object.");
  }
  for (const field of ["repoUrl", "baseBranch", "specRef"] as const) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      throw new Error(`builder expected ${field} to be a non-empty string.`);
    }
  }
  if (!isRecord(value.options) || Array.isArray(value.options)) {
    throw new Error("builder expected options to be an object.");
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

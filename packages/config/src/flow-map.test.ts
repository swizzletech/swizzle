import { describe, expect, it } from "vitest";

import { extractFlowNodeIds, flowDrift, scanStepSites } from "./flow-map.js";

const NODE_SOURCE = `import { runStep, requestApproval, invokeAutomation, sleep } from "./swizzle-sdk.ts";
// runStep("in-a-comment", () => 1)
const label = "runStep('in-a-string', x)";
export async function main() {
  const parsed = await runStep("parse", async () => {
    return JSON.parse(")"); // a paren in a string
  });
  await sleep("cool-down", 1_000);
  const approval = await requestApproval("review", {
    details: { parsed },
  });
  await invokeAutomation("notify", "mailer", { approval });
  await runStep(\`dynamic-\${parsed.id}\`, () => 1);
  await runStep(keyVariable, () => 1);
  return runStep(\`plain-template\`, () => approval);
}
`;

const PYTHON_SOURCE = `from swizzle_sdk import run_step, request_approval, sleep_until
# run_step("comment", lambda: 1)
def main():
    """run_step("docstring", lambda: 1)"""
    text = run_step("parse", lambda: f"{payload}")
    sleep_until("tomorrow", "2030-01-01T00:00:00Z")
    request_approval(
        "review",
        details={"text": text},
    )
    return text
`;

describe("scanStepSites", () => {
  it("finds every helper call with a literal key in a TypeScript entrypoint", () => {
    expect(scanStepSites("node", NODE_SOURCE)).toEqual([
      { endLine: 7, key: "parse", kind: "step", startLine: 5, target: null },
      { endLine: 8, key: "cool-down", kind: "sleep", startLine: 8, target: null },
      { endLine: 11, key: "review", kind: "approval", startLine: 9, target: null },
      { endLine: 12, key: "notify", kind: "child", startLine: 12, target: "mailer" },
      { endLine: 15, key: "plain-template", kind: "step", startLine: 15, target: null },
    ]);
  });

  it("finds Python helper calls and skips comments, docstrings and f-strings", () => {
    expect(scanStepSites("python", PYTHON_SOURCE)).toEqual([
      { endLine: 5, key: "parse", kind: "step", startLine: 5, target: null },
      { endLine: 6, key: "tomorrow", kind: "sleep", startLine: 6, target: null },
      { endLine: 10, key: "review", kind: "approval", startLine: 7, target: null },
    ]);
  });

  it("finds a call nested in a step's callback and skips a key built at run time", () => {
    const source = `await runStep("outer", async () => invokeAutomation("child", "mailer", {}));
await runStep("prefix-" + id, fn);
await invokeAutomation("send", "mailer-" + region, {});
`;
    expect(scanStepSites("node", source)).toEqual([
      { endLine: 1, key: "outer", kind: "step", startLine: 1, target: null },
      { endLine: 1, key: "child", kind: "child", startLine: 1, target: "mailer" },
      { endLine: 3, key: "send", kind: "child", startLine: 3, target: null },
    ]);
  });

  it("reads past a regex literal, decodes escapes and ignores inherited property names", () => {
    const source = `const ok = await runStep("parse", () => /\\)/.test(value) && a / b / c);
await runStep("\\u0070arse-\\x41", fn);
obj.toString("label");
await runStep("after", fn);
`;
    expect(scanStepSites("node", source)).toEqual([
      { endLine: 1, key: "parse", kind: "step", startLine: 1, target: null },
      { endLine: 2, key: "parse-A", kind: "step", startLine: 2, target: null },
      { endLine: 4, key: "after", kind: "step", startLine: 4, target: null },
    ]);
  });

  it("ignores the helper's own definition in an SDK copy", () => {
    const sdk = `export async function runStep<T>(name: string, fn: () => T): Promise<T> {\n  return fn();\n}\n`;
    expect(scanStepSites("node", sdk)).toEqual([]);
  });
});

describe("extractFlowNodeIds", () => {
  it("keeps comment markers inside labels and ignores actual comments", () => {
    expect(
      extractFlowNodeIds(`flowchart LR
  fetch["100%% complete"] --> notify[100%% ready]
  notify -->|100%% sure| done %% comment --> phantom
`),
    ).toEqual(["fetch", "notify", "done"]);
  });

  it("reads front matter and semicolon statements without treating labels or directives as ids", () => {
    expect(
      extractFlowNodeIds(`---
title: A flow
---
flowchart LR; parse["Parse; payload"] --> review; style parse fill:#fff; review --> done((Done))
`),
    ).toEqual(["parse", "review", "done"]);
  });

  it("reads ids from shapes, chains, labelled arrows and subgraphs", () => {
    const ids = extractFlowNodeIds(`%% a comment
flowchart LR
  trigger([Webhook]) --> parse[Parse the payload]
  parse --> check{Valid?}
  check -->|yes| review[/Ask for approval/] & cool-down
  check -- no --> done((Done))
  subgraph later
    direction TB
    notify[["Notify (mailer)"]]:::child
  end
  review -.-> notify@{ shape: cyl, label: "x" }
  classDef child fill:#eee
  style parse fill:#fff
`);
    expect(ids).toEqual(["trigger", "parse", "check", "review", "cool-down", "done", "notify"]);
  });

  it("ends a compact arrow at its head, so ids starting with o or x survive", () => {
    expect(extractFlowNodeIds("flowchart LR\n  a-->output\n  a--xx\n  output--oo\n")).toEqual([
      "a",
      "output",
      "x",
      "o",
    ]);
  });

  it("returns nothing for a diagram that is not a flowchart", () => {
    expect(extractFlowNodeIds("sequenceDiagram\n  A->>B: hi\n")).toEqual([]);
  });
});

describe("flowDrift", () => {
  const sites = scanStepSites("node", NODE_SOURCE);

  it("names the steps without a node and treats nodes without a step as narration", () => {
    const drift = flowDrift(["trigger", "parse", "review", "done"], sites);
    expect(drift.map((warning) => warning.id)).toEqual(["cool-down", "notify", "plain-template"]);
    expect(drift[0]?.message).toContain("line 8");
  });

  it("finds nothing when every step has a node", () => {
    expect(
      flowDrift(["trigger", "parse", "cool-down", "review", "notify", "plain-template"], sites),
    ).toEqual([]);
  });
});

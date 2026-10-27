import { describe, expect, it } from "vitest";

import type { AutomationSummary, RunStatus } from "./api";
import {
  type AutomationListItem,
  groupAutomationsIntoPipelines,
  isAutomationLive,
} from "./pipeline-grouping";

function automation(
  slug: string,
  opts: {
    readonly triggerType?: "webhook" | "cron" | "chain";
    readonly sources?: readonly string[];
    readonly lastRunStatus?: RunStatus;
    readonly queuedAt?: string;
    readonly invokes?: readonly string[];
  } = {},
): AutomationSummary {
  const triggerType = opts.triggerType ?? "webhook";
  return {
    automationName: slug,
    automationSlug: slug,
    invokesAutomationSlugs: opts.invokes ?? [],
    lastRun: opts.lastRunStatus
      ? { queuedAt: opts.queuedAt ?? "2026-07-09T10:00:00.000Z", status: opts.lastRunStatus }
      : null,
    trigger: {
      chainSourceAutomationSlugs: opts.sources ?? [],
      triggerType,
    },
    // The grouping algorithm reads only slug/name/trigger/lastRun; the rest of
    // the summary shape is irrelevant here.
  } as unknown as AutomationSummary;
}

// exec-intake → exec-build → { review-standards ∥ review-spec ∥ e2e } → exec-triage
function execPipeline(): readonly AutomationSummary[] {
  return [
    automation("exec-build", { sources: ["exec-intake"], triggerType: "chain" }),
    automation("exec-e2e", { sources: ["exec-build"], triggerType: "chain" }),
    automation("exec-intake", { triggerType: "webhook" }),
    automation("exec-review-spec", { sources: ["exec-build"], triggerType: "chain" }),
    automation("exec-review-standards", { sources: ["exec-build"], triggerType: "chain" }),
    automation("exec-triage", {
      sources: ["exec-review-standards", "exec-review-spec", "exec-e2e"],
      triggerType: "chain",
    }),
  ];
}

function onlyGroup(items: readonly AutomationListItem[]) {
  const group = items.find((item) => item.kind === "group");
  if (group === undefined || group.kind !== "group") {
    throw new Error("Expected a pipeline group in the result.");
  }
  return group;
}

describe("groupAutomationsIntoPipelines", () => {
  it("keeps unrelated automations as standalone rows", () => {
    const items = groupAutomationsIntoPipelines([
      automation("hello-webhook"),
      automation("nightly-report", { triggerType: "cron" }),
    ]);

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.kind === "single")).toBe(true);
  });

  it("collapses a connected chain pipeline into one group with the entry as label", () => {
    const items = groupAutomationsIntoPipelines([automation("hello-webhook"), ...execPipeline()]);

    // hello-webhook stays single; the six exec-* members collapse to one group.
    expect(items.filter((item) => item.kind === "single")).toHaveLength(1);
    const group = onlyGroup(items);
    expect(group.key).toBe("exec-intake");
    expect(group.entry.automationSlug).toBe("exec-intake");
    expect(group.stageCount).toBe(6);
  });

  it("layers parallel stages together: reviews share a layer between build and triage", () => {
    const group = onlyGroup(groupAutomationsIntoPipelines(execPipeline()));
    const layerSlugs = group.layers.map((layer) => layer.map((m) => m.automationSlug));
    expect(layerSlugs[0]).toEqual(["exec-intake"]);
    expect(layerSlugs[1]).toEqual(["exec-build"]);
    expect(layerSlugs[2]).toEqual(["exec-e2e", "exec-review-spec", "exec-review-standards"]);
    expect(layerSlugs[3]).toEqual(["exec-triage"]);
    // Flattened layers are exactly the display order.
    expect(group.layers.flat()).toEqual(group.members);
  });

  it("groups an inviter with its target, source first, whatever the list order", () => {
    const items = groupAutomationsIntoPipelines([
      automation("mailer"),
      automation("orders", { invokes: ["mailer"] }),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0];
    if (group?.kind !== "group") throw new Error("expected a group");
    expect(group.entry.automationSlug).toBe("orders");
    expect(group.members.map((member) => member.automationSlug)).toEqual(["orders", "mailer"]);
  });

  it("orders a mixed pipeline by chain and invoke edges and ignores an absent invoke target", () => {
    const items = groupAutomationsIntoPipelines([
      automation("report", { sources: ["orders"], triggerType: "chain" }),
      automation("mailer"),
      automation("orders", { invokes: ["mailer", "not-deployed-here"] }),
      automation("alone", { invokes: ["elsewhere"] }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["group", "single"]);
    const group = items[0];
    if (group?.kind !== "group") throw new Error("expected a group");
    expect(group.layers.map((layer) => layer.map((member) => member.automationSlug))).toEqual([
      ["orders"],
      ["mailer", "report"],
    ]);
  });

  it("does not group a chain trigger whose source is absent (cross-environment)", () => {
    const items = groupAutomationsIntoPipelines([
      automation("orphan-consumer", { sources: ["missing-source"], triggerType: "chain" }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("single");
  });

  it("marks the group live when any member is running or queued", () => {
    const members = execPipeline().map((member) =>
      member.automationSlug === "exec-e2e"
        ? automation("exec-e2e", {
            lastRunStatus: "running",
            sources: ["exec-build"],
            triggerType: "chain",
          })
        : member,
    );

    const group = onlyGroup(groupAutomationsIntoPipelines(members));
    expect(group.live).toBe(true);
    expect(group.failing).toBe(false);
  });

  it("marks the group failing when any member dead-lettered", () => {
    const members = execPipeline().map((member) =>
      member.automationSlug === "exec-triage"
        ? automation("exec-triage", {
            lastRunStatus: "dead-lettered",
            sources: ["exec-review-standards", "exec-review-spec", "exec-e2e"],
            triggerType: "chain",
          })
        : member,
    );

    const group = onlyGroup(groupAutomationsIntoPipelines(members));
    expect(group.failing).toBe(true);
  });

  it("reports the most recent member activity", () => {
    const members = [
      automation("exec-intake", {
        queuedAt: "2026-07-09T09:00:00.000Z",
        lastRunStatus: "succeeded",
      }),
      automation("exec-build", {
        lastRunStatus: "succeeded",
        queuedAt: "2026-07-09T12:30:00.000Z",
        sources: ["exec-intake"],
        triggerType: "chain",
      }),
    ];

    const group = onlyGroup(groupAutomationsIntoPipelines(members));
    expect(group.lastActivityAt).toBe("2026-07-09T12:30:00.000Z");
  });
});

describe("isAutomationLive", () => {
  it("counts only queued and running latest runs as live", () => {
    expect(isAutomationLive(automation("a", { lastRunStatus: "queued" }))).toBe(true);
    expect(isAutomationLive(automation("a", { lastRunStatus: "running" }))).toBe(true);
    expect(isAutomationLive(automation("a", { lastRunStatus: "succeeded" }))).toBe(false);
    expect(isAutomationLive(automation("a"))).toBe(false);
  });
});

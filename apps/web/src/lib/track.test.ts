import type { StepSite } from "@swizzle/config/browser";
import { describe, expect, it } from "vitest";

import type { RunDetail } from "./api";
import {
  activeStep,
  buildReplay,
  type FlowGraph,
  type FlowNode,
  positionAt,
  staticTrack,
  type TrackStep,
  trackForRun,
  waitingStep,
} from "./track";

// trigger → fetch → check{Over 100?} ─yes→ review → notify → done
//                                    ─no→ notify
const FLOW: FlowGraph = {
  direction: "LR",
  edges: [
    { from: "trigger", label: null, to: "fetch" },
    { from: "fetch", label: null, to: "check" },
    { from: "check", label: "yes", to: "review" },
    { from: "review", label: null, to: "notify" },
    { from: "check", label: "no", to: "notify" },
    { from: "notify", label: null, to: "done" },
  ],
  nodes: [
    { id: "trigger", label: "Webhook", shape: "pill" },
    { id: "fetch", label: "Fetch the order", shape: "box" },
    { id: "check", label: "Over 100?", shape: "diamond" },
    { id: "review", label: "Ask for approval", shape: "box" },
    { id: "notify", label: "Notify", shape: "box" },
    { id: "done", label: "Result", shape: "pill" },
  ],
};

/** The steps the entrypoint declares; trigger, check and done are narration. */
const KEYS: ReadonlySet<string> = new Set(["fetch", "review", "notify", "cool-down"]);

const T0 = Date.parse("2026-10-24T10:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function step(key: string, startedMs: number | null, finishedMs: number | null): TrackStep {
  return {
    approval: null,
    attempt: 1,
    executionNumber: 1,
    createdAt: at(startedMs ?? finishedMs ?? 0),
    finishedAt: finishedMs === null ? null : at(finishedMs),
    startedAt: startedMs === null ? null : at(startedMs),
    stepKey: key,
    updatedAt: at(finishedMs ?? startedMs ?? 0),
    value: null,
  };
}

function run(
  overrides: Partial<RunDetail>,
): Pick<RunDetail, "approval" | "finishedAt" | "startedAt" | "status" | "wait"> {
  return {
    approval: null,
    finishedAt: null,
    startedAt: at(0),
    status: "running",
    wait: null,

    ...overrides,
  };
}

const states = (nodes: readonly { id: string; state: string }[]) =>
  Object.fromEntries(nodes.map((node) => [node.id, node.state]));
const lanes = (edges: readonly { from: string; to: string; state: string }[]) =>
  Object.fromEntries(edges.map((edge) => [`${edge.from}>${edge.to}`, edge.state]));

describe("trackForRun", () => {
  it("lights the running step, marks done steps with their duration and lights narration behind them", () => {
    const steps = new Map([
      ["fetch", step("fetch", 100, 500)],
      ["review", step("review", 600, null)],
    ]);
    const track = trackForRun(FLOW, run({}), { steps, waiting: null }, KEYS);
    expect(states(track.nodes)).toEqual({
      check: "done",
      done: "idle",
      fetch: "done",
      notify: "idle",
      review: "running",
      trigger: "done",
    });
    expect(track.nodes.find((node) => node.id === "fetch")).toMatchObject({
      durationMs: 400,
      key: "fetch",
      meta: "0.4 s",
    });
    expect(track.nodes.find((node) => node.id === "trigger")?.key).toBeNull();
    expect(lanes(track.edges)).toEqual({
      "check>notify": "untaken",
      "check>review": "active",
      "fetch>check": "done",
      "notify>done": "idle",
      "review>notify": "idle",
      "trigger>fetch": "done",
    });
  });

  it("dots the branch a finished run never took", () => {
    const steps = new Map([
      ["fetch", step("fetch", 100, 500)],
      ["notify", step("notify", 600, 900)],
    ]);
    const finished = run({ finishedAt: at(1_000), status: "succeeded" });
    const track = trackForRun(FLOW, finished, { steps, waiting: null }, KEYS);
    expect(lanes(track.edges)).toMatchObject({
      "check>notify": "done",
      "check>review": "untaken",
      "notify>done": "done",
      "review>notify": "idle",
    });
    expect(states(track.nodes).done).toBe("done");
  });

  it("times a wait from the step before it, and dots the branch the run reached by another path", () => {
    // The run took "yes": review (an approval, no start of its own) ended at 60 s, notify after.
    const steps = new Map([
      ["fetch", step("fetch", 100, 500)],
      ["review", step("review", null, 60_000)],
      ["notify", step("notify", 60_100, 60_300)],
    ]);
    const finished = run({ finishedAt: at(60_400), status: "succeeded" });
    const track = trackForRun(FLOW, finished, { steps, waiting: null }, KEYS);
    expect(track.nodes.find((node) => node.id === "review")).toMatchObject({
      durationMs: 59_500,
      state: "done",
    });
    expect(lanes(track.edges)).toMatchObject({
      "check>notify": "untaken",
      "check>review": "done",
      "review>notify": "done",
    });
  });

  it("lights the end of a flow when the run reached it through one branch only", () => {
    // check ─yes→ review → result; check ─no→ skip → result. Only review ran.
    const flow: FlowGraph = {
      direction: "LR",
      edges: [
        { from: "fetch", label: null, to: "check" },
        { from: "check", label: "yes", to: "review" },
        { from: "check", label: "no", to: "skip" },
        { from: "review", label: null, to: "result" },
        { from: "skip", label: null, to: "result" },
      ],
      nodes: [
        { id: "fetch", label: "Fetch", shape: "box" },
        { id: "check", label: "Over 100?", shape: "diamond" },
        { id: "review", label: "Review", shape: "box" },
        { id: "skip", label: "Skip", shape: "box" },
        { id: "result", label: "Result", shape: "pill" },
      ],
    };
    const steps = new Map([
      ["fetch", step("fetch", 100, 500)],
      ["review", step("review", null, 2_000)],
    ]);
    const live = trackForRun(
      flow,
      run({}),
      { steps, waiting: null },
      new Set(["fetch", "review", "skip"]),
    );
    expect(states(live.nodes)).toMatchObject({ check: "done", result: "done", skip: "idle" });
    expect(lanes(live.edges)).toMatchObject({
      "check>review": "done",
      "check>skip": "untaken",
      "review>result": "done",
      "skip>result": "idle",
    });
    // Undecided, the end waits: review is still running.
    const open = trackForRun(
      flow,
      run({}),
      {
        steps: new Map([
          ["fetch", step("fetch", 100, 500)],
          ["review", step("review", 600, null)],
        ]),
        waiting: null,
      },
      new Set(["fetch", "review", "skip"]),
    );
    expect(states(open.nodes)).toMatchObject({ result: "idle", review: "running", skip: "idle" });
  });

  it("shows the approval station waiting with its words, and a step the attempt died in as failed", () => {
    const waiting = run({
      approval: {
        assignee: null,
        details: null,
        may: { decide: true, reassign: false },
        stepKey: "review",
      },
      status: "waiting",
      wait: {
        stepKey: "review",
        reason: "event",
        until: null,
        details: null,
        startedAt: "2026-10-24T12:00:00.000Z",
      },
    });
    const track = trackForRun(
      FLOW,
      waiting,
      {
        steps: new Map([["fetch", step("fetch", 100, 500)]]),
        waiting: waitingStep(waiting),
      },
      KEYS,
    );
    expect(track.nodes.find((node) => node.id === "review")).toMatchObject({
      key: "review",
      meta: "waiting for approval",
      state: "waiting",
    });
    expect(activeStep(track)).toBe("review");

    const dead = trackForRun(
      FLOW,
      run({ status: "dead-lettered" }),
      {
        steps: new Map([["fetch", step("fetch", 100, null)]]),
        waiting: null,
      },
      KEYS,
    );
    expect(dead.nodes.find((node) => node.id === "fetch")).toMatchObject({
      meta: "did not finish",
      state: "failed",
    });
  });

  it("names the last done step as active once nothing runs", () => {
    const steps = new Map([
      ["fetch", step("fetch", 100, 500)],
      ["notify", step("notify", 600, 900)],
    ]);
    const track = trackForRun(FLOW, run({ status: "succeeded" }), { steps, waiting: null }, KEYS);
    expect(activeStep(track)).toBe("notify");
  });
});

describe("staticTrack", () => {
  it("counts how many of the last runs reached each step", () => {
    const track = staticTrack(FLOW, new Set(["fetch", "review", "notify"]), {
      reached: { fetch: 12, notify: 12 },
      runs: 12,
    });
    expect(track.nodes.map((node) => [node.id, node.key, node.meta])).toEqual([
      ["trigger", null, null],
      ["fetch", "fetch", "12 of 12 runs"],
      ["check", null, null],
      ["review", "review", "0 of 12 runs"],
      ["notify", "notify", "12 of 12 runs"],
      ["done", null, null],
    ]);
    expect(track.edges.every((edge) => edge.state === "idle")).toBe(true);
  });
});

const SITES: readonly StepSite[] = [
  { endLine: 3, key: "fetch", kind: "step", startLine: 3, target: null },
  { endLine: 5, key: "review", kind: "approval", startLine: 5, target: null },
  { endLine: 6, key: "cool-down", kind: "sleep", startLine: 6, target: null },
  { endLine: 7, key: "notify", kind: "step", startLine: 7, target: null },
];

describe("replay", () => {
  const DAY = 24 * 60 * 60_000;
  const finished = run({ finishedAt: at(2 * DAY + 5_000), status: "succeeded" });
  const steps = [
    step("notify", 2 * DAY + 4_000, 2 * DAY + 4_200),
    step("fetch", 100, 500),
    step("review", null, 2 * DAY),
    step("cool-down", null, 2 * DAY + 3_000),
  ];

  it("compresses a two-day approval and a sleep to a second and a half each", () => {
    const replay = buildReplay(finished, steps, SITES);
    expect(replay.compressed).toBe(true);
    expect(replay.spans.map((span) => [span.key, span.kind, span.playTo - span.playFrom])).toEqual([
      ["fetch", "step", 400],
      ["review", "wait", 1_500],
      ["cool-down", "wait", 1_500],
      ["notify", "step", 350],
    ]);
    // The gap before fetch, no gaps between the waits, a 1 s gap before notify, a 0.8 s tail.
    expect(replay.length).toBe(100 + 400 + 1_500 + 1_500 + 400 + 350 + 400);
  });

  it("answers the position at a point of the replay", () => {
    const replay = buildReplay(finished, steps, SITES);
    const midApproval = positionAt(replay, 100 + 400 + 700, SITES);
    expect(midApproval.steps.get("fetch")?.finishedAt).toBe(at(500));
    expect(midApproval.waiting).toMatchObject({
      approval: { stepKey: "review" },
      reason: "approval",
      stepKey: "review",
    });
    const track = trackForRun(FLOW, run({}), midApproval, KEYS);
    expect(states(track.nodes)).toMatchObject({ fetch: "done", notify: "idle", review: "waiting" });

    const end = positionAt(replay, replay.length, SITES);
    expect(end.waiting).toBeNull();
    expect([...end.steps.keys()].sort()).toEqual(["cool-down", "fetch", "notify", "review"]);
  });
});

// check{Taken?} ─yes→ accepted ─→ ship (step)
//               ─no→  rejected ─→ archive (step)
// Both lanes of the decision lead to narration nodes, and only the step behind a lane tells which
// one the run took.
describe("trackForRun with a decision between narration nodes", () => {
  const BRANCH: FlowGraph = {
    direction: "LR",
    edges: [
      { from: "check", label: "yes", to: "accepted" },
      { from: "check", label: "no", to: "rejected" },
      { from: "accepted", label: null, to: "ship" },
      { from: "rejected", label: null, to: "archive" },
    ],
    nodes: [
      { id: "check", label: "Taken?", shape: "diamond" },
      { id: "accepted", label: "Accepted", shape: "pill" },
      { id: "rejected", label: "Rejected", shape: "pill" },
      { id: "ship", label: "Ship", shape: "box" },
      { id: "archive", label: "Archive", shape: "box" },
    ],
  };
  const KEYS_BRANCH: ReadonlySet<string> = new Set(["ship", "archive"]);
  const finished = run({ finishedAt: at(1_000), status: "succeeded" });

  it("marks only the lane to the narration node whose step the run reached", () => {
    const steps = new Map([["ship", step("ship", 100, 400)]]);
    const track = trackForRun(BRANCH, finished, { steps, waiting: null }, KEYS_BRANCH);
    expect(lanes(track.edges)).toEqual({
      "accepted>ship": "done",
      "check>accepted": "done",
      "check>rejected": "untaken",
      "rejected>archive": "idle",
    });
    expect(states(track.nodes)).toMatchObject({ accepted: "done", rejected: "idle" });
  });

  it("leaves both lanes open when no step shows which one the run took", () => {
    const track = trackForRun(BRANCH, finished, { steps: new Map(), waiting: null }, KEYS_BRANCH);
    expect(lanes(track.edges)).toMatchObject({
      "check>accepted": "idle",
      "check>rejected": "idle",
    });
  });

  it("keeps both sides open when they rejoin at the step the run recorded, in either node order", () => {
    const edges = [
      { from: "check", label: "yes", to: "accepted" },
      { from: "check", label: "no", to: "rejected" },
      { from: "accepted", label: null, to: "ship" },
      { from: "rejected", label: null, to: "ship" },
    ];
    const [check, accepted, rejected, ship]: FlowNode[] = [
      { id: "check", label: "Taken?", shape: "diamond" },
      { id: "accepted", label: "Accepted", shape: "pill" },
      { id: "rejected", label: "Rejected", shape: "pill" },
      { id: "ship", label: "Ship", shape: "box" },
    ] as [FlowNode, FlowNode, FlowNode, FlowNode];
    const steps = new Map([["ship", step("ship", 100, 400)]]);
    for (const order of [
      [check, accepted, rejected, ship],
      [check, rejected, accepted, ship],
    ]) {
      const flow: FlowGraph = { direction: "LR", edges, nodes: order };
      const track = trackForRun(flow, finished, { steps, waiting: null }, new Set(["ship"]));
      expect(lanes(track.edges)).toMatchObject({
        "check>accepted": "idle",
        "check>rejected": "idle",
      });
    }
  });

  it.each(["done", "waiting"] as const)(
    "keeps unequal-depth reconverged decision lanes open with a %s station in every node order",
    (stationState) => {
      const nodes: FlowNode[] = [
        { id: "check", label: "Taken?", shape: "diamond" },
        { id: "accepted", label: "Accepted", shape: "pill" },
        { id: "prepare", label: "Prepare", shape: "pill" },
        { id: "rejected", label: "Rejected", shape: "pill" },
        { id: "ship", label: "Ship", shape: "box" },
      ];
      const edges = [
        { from: "check", label: "yes", to: "accepted" },
        { from: "accepted", label: null, to: "prepare" },
        { from: "prepare", label: null, to: "ship" },
        { from: "check", label: "no", to: "rejected" },
        { from: "rejected", label: null, to: "ship" },
      ];
      function orders(remaining: readonly FlowNode[]): FlowNode[][] {
        if (remaining.length === 0) return [[]];
        return remaining.flatMap((node, index) =>
          orders(remaining.filter((_, other) => other !== index)).map((rest) => [node, ...rest]),
        );
      }
      const steps =
        stationState === "done" ? new Map([["ship", step("ship", 100, 400)]]) : new Map();
      for (const order of orders(nodes)) {
        const track = trackForRun(
          { direction: "LR", edges, nodes: order },
          stationState === "done" ? finished : run({ status: "waiting" }),
          {
            steps,
            waiting:
              stationState === "waiting"
                ? { approval: null, reason: "event", stepKey: "ship", until: null }
                : null,
          },
          new Set(["ship"]),
        );
        expect(lanes(track.edges), order.map((node) => node.id).join(",")).toMatchObject({
          "check>accepted": "idle",
          "check>rejected": "idle",
        });
        expect(states(track.nodes)).toMatchObject({
          accepted: "idle",
          check: "done",
          rejected: "idle",
          ship: stationState,
        });
      }
    },
  );

  it("walks a long chain of split and rejoin decisions without enumerating paths", () => {
    const nodes: FlowNode[] = [{ id: "d0", label: "d0", shape: "diamond" }];
    const edges: { from: string; to: string; label: null }[] = [];
    for (let index = 0; index < 40; index += 1) {
      nodes.push(
        { id: `a${index}`, label: "a", shape: "pill" },
        { id: `b${index}`, label: "b", shape: "pill" },
        { id: `d${index + 1}`, label: "d", shape: "diamond" },
      );
      for (const side of ["a", "b"]) {
        edges.push({ from: `d${index}`, label: null, to: `${side}${index}` });
        edges.push({ from: `${side}${index}`, label: null, to: `d${index + 1}` });
      }
    }
    const flow: FlowGraph = { direction: "LR", edges, nodes };
    // Path enumeration would not return within the test timeout.
    const track = trackForRun(flow, run({}), { steps: new Map(), waiting: null }, new Set());
    expect(track.nodes).toHaveLength(nodes.length);
  });
});

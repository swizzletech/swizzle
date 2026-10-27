import { expect, test } from "vitest";
import { compare, formatComparison, type PerfResult, parseResult, Rounds } from "./result.ts";

/** A result whose only metrics took these per-round values. */
function result(latency: number[], throughput: number[]): PerfResult {
  const rounds = new Rounds();
  for (const value of latency) rounds.record("GET /runs", "p95", "ms", "lower", value);
  for (const value of throughput)
    rounds.record("GET /runs", "throughput", "req/s", "higher", value);
  return {
    experiment: null,
    scenario: { workerReplicas: 1, workerConcurrency: 2 },
    git: { dirty: false, sha: "0".repeat(40) },
    machine: {
      cores: 8,
      cpu: "cpu",
      docker: "29",
      host: "host",
      loadAfter: [0, 0, 0],
      loadBefore: [0, 0, 0],
      memoryGiB: 16,
      node: "v22",
      os: "Linux",
    },
    metrics: rounds.metrics(),
    profile: { rounds: latency.length },
    startedAt: "2026-10-23T00:00:00.000Z",
    target: "api",
  };
}

/** The comparison of two runs of one scenario. */
function judged(base: PerfResult, head: PerfResult) {
  const comparison = compare(base, head);
  if (comparison.kind !== "judged") throw new Error(`not judged: ${comparison.kind}`);
  return comparison;
}

const verdicts = (base: PerfResult, head: PerfResult) =>
  judged(base, head).deltas.map(({ delta, head: metric, spread, verdict }) => [
    metric.name,
    delta,
    spread,
    verdict,
  ]);

test("a delta inside the larger range of the rounds is no difference", () => {
  // Medians 20 and 22; the head's rounds span 4, so +2 ms is noise, as is -50 req/s within 100.
  expect(
    verdicts(result([19, 20, 21], [1000, 1050, 1100]), result([20, 22, 24], [950, 1000, 1050])),
  ).toEqual([
    ["p95", 2, 4, "same"],
    ["throughput", -50, 100, "same"],
  ]);
});

test("a delta beyond the spread is judged by the direction the metric improves in", () => {
  expect(
    verdicts(result([20, 20, 21], [1000, 1000, 1010]), result([30, 30, 31], [1200, 1200, 1210])),
  ).toEqual([
    ["p95", 10, 1, "worse"],
    ["throughput", 200, 10, "better"],
  ]);
  expect(
    verdicts(result([30, 30, 31], [1200, 1200, 1210]), result([20, 20, 21], [1000, 1000, 1010])),
  ).toEqual([
    ["p95", -10, 1, "better"],
    ["throughput", -200, 10, "worse"],
  ]);
});

test("a memory delta under the unit's resolution or the service's huge pages is no difference", () => {
  const memory = (value: number, hugePages = 0) => {
    const rounds = new Rounds();
    for (let round = 0; round < 3; round += 1) {
      rounds.record("service valkey", "rss", "MiB", "lower", value, hugePages);
    }
    return { ...result([20], [1000]), metrics: rounds.metrics() };
  };
  expect(verdicts(memory(3.9), memory(4.0))).toEqual([["rss", expect.closeTo(0.1), 1, "same"]]);
  expect(verdicts(memory(3.9), memory(6.0))).toEqual([["rss", expect.closeTo(2.1), 1, "worse"]]);
  // An idle valkey that started with 10 MiB in huge pages: the 7.9 MiB came from the start.
  expect(verdicts(memory(3.9), memory(11.8, 10))).toEqual([
    ["rss", expect.closeTo(7.9), 10, "same"],
  ]);
});

test("a metric one side lacks or measures in another unit is reported, not judged", () => {
  const base = result([20, 20, 21], [1000, 1000, 1010]);
  const rounds = new Rounds();
  rounds.record("GET /runs", "p95", "s", "lower", 0.03);
  rounds.record("page /runs", "LCP", "ms", "lower", 700);
  const { deltas, onlyBase, onlyHead, redefined } = judged(base, {
    ...base,
    metrics: rounds.metrics(),
  });
  expect(deltas).toEqual([]);
  expect(redefined.map(({ base, head }) => [head.name, base.unit, head.unit])).toEqual([
    ["p95", "ms", "s"],
  ]);
  expect(onlyBase.map((metric) => metric.name)).toEqual(["throughput"]);
  expect(onlyHead.map((metric) => metric.name)).toEqual(["LCP"]);
});

test("runs of different profiles are not judged", () => {
  // Twice the clients: the same code reads slower, which must not count as a regression.
  const base = { ...result([20, 20, 21], [1000, 1000, 1010]), profile: { apiConcurrency: 8 } };
  const head = { ...result([40, 40, 41], [600, 600, 610]), profile: { apiConcurrency: 16 } };
  expect(compare(base, head)).toEqual({
    differences: [{ base: 8, head: 16, name: "apiConcurrency" }],
    kind: "other scenario",
  });
});

test("a sample that is not a finite number fails the run and names the metric", () => {
  // A terminal run without finishedAt yields NaN, which JSON would store as null.
  expect(() =>
    new Rounds().record("run hello-webhook", "total p50", "ms", "lower", Number.NaN),
  ).toThrow("run hello-webhook total p50 measured NaN ms");
});

test("effective worker capacity defines the scenario even with identical profiles", () => {
  const base = { ...result([20], [1000]), scenario: { workerConcurrency: 2, workerReplicas: 1 } };
  const head = { ...base, scenario: { workerConcurrency: 4, workerReplicas: 1 } };
  expect(compare(base, head)).toEqual({
    differences: [{ base: 2, head: 4, name: "stack.workerConcurrency" }],
    kind: "other scenario",
  });
});

test("a saved result round trips through the current input boundary", () => {
  const saved = result([19, 20, 21], [900, 1000, 1100]);
  expect(parseResult(JSON.stringify(saved))).toEqual(saved);
});

test.each([
  ["missing fields", {}, "startedAt"],
  ["missing scenario", { ...result([20], [1000]), scenario: undefined }, "scenario"],
  ["invalid target", { ...result([20], [1000]), target: "other" }, "target"],
  [
    "nonfinite profile",
    { ...result([20], [1000]), profile: { rounds: Number.POSITIVE_INFINITY } },
    "profile.rounds",
  ],
  [
    "missing worker capacity",
    { ...result([20], [1000]), scenario: {} },
    "scenario.workerConcurrency",
  ],
])("saved results reject %s", (_label, value, field) => {
  expect(() => parseResult(JSON.stringify(value))).toThrow(field);
});

test.each([
  ["median", null, "median"],
  ["median", "20", "median"],
  ["median", 1e300 * 1e300, "median"],
  ["min", 21, "min <= median <= max"],
  ["max", 19, "min <= median <= max"],
  ["floor", -1, "floor"],
  ["rounds", 0, "rounds"],
  ["rounds", 1.5, "rounds"],
  ["unit", "minutes", "unit"],
  ["better", "fast", "better"],
])("saved metric rejects %s=%s", (field, value, error) => {
  const saved = result([20], [1000]);
  const metrics = saved.metrics.map((entry) => ({ ...entry, [field]: value }));
  expect(() => parseResult(JSON.stringify({ ...saved, metrics }))).toThrow(error);
});

test("configuration experiments name the intent and refuse regression verdicts", () => {
  const base = result([20], [1000]);
  const head = {
    ...base,
    experiment: "worker capacity",
    scenario: { workerConcurrency: 4, workerReplicas: 1 },
  };
  const report = formatComparison(base, head);
  expect(report).toContain("configuration experiment: worker capacity");
  expect(report).toContain("stack.workerConcurrency: base 2, head 4");
  expect(report).toContain("not compared:");
  expect(report).not.toContain("WORSE");
});

test("overflowing JSON metric numbers cannot bypass finite-number validation", () => {
  const json = JSON.stringify(result([20], [1000])).replace('"median":20', '"median":1e309');
  expect(() => parseResult(json)).toThrow("metrics[0].median must be a finite number");
});

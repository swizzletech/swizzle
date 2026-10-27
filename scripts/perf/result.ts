// The result of one `just perf` run and the comparison of two. A run measures every metric once
// per round; a metric keeps the median of its rounds and their range, the run-to-run spread.
// scripts/perf.mts writes a PerfResult as JSON, prints `summarize` or, given a base, `compare`.

/** Which way a metric improves. */
type Better = "lower" | "higher";

type Unit = "ms" | "s" | "req/s" | "runs/s" | "cpu-s" | "MiB" | "KiB" | "count" | "score";

/** One quantity measured once per round. `min` and `max` bound the rounds: the spread. */
export interface Metric {
  /** The row the summary prints it in, for example `GET /dashboard/runs` or `page /runs`. */
  readonly group: string;
  /** The column, for example `p95`, `LCP` or `cpu`. */
  readonly name: string;
  readonly unit: Unit;
  readonly better: Better;
  readonly median: number;
  readonly min: number;
  readonly max: number;
  readonly rounds: number;
  /**
   * The largest difference that can come from how the run started rather than from the commit,
   * which the rounds of one run cannot show: for resident memory, what the kernel handed the
   * service in huge pages. 0 for most metrics.
   */
  readonly floor: number;
}

export type Target = "api" | "web" | "all";

/** What a run measured on, so a number can be explained and two runs judged comparable. */
export interface PerfResult {
  readonly startedAt: string;
  readonly target: Target;
  readonly git: { readonly sha: string; readonly dirty: boolean };
  readonly machine: {
    readonly host: string;
    readonly cpu: string;
    readonly cores: number;
    readonly memoryGiB: number;
    readonly os: string;
    readonly node: string;
    readonly docker: string;
    /** 1, 5 and 15 minute load averages before the first and after the last round. */
    readonly loadBefore: readonly number[];
    readonly loadAfter: readonly number[];
    /**
     * Share of the measured time in which some task on the host waited for a CPU or for IO, from
     * Linux pressure stall information. Absent where the kernel does not report it.
     */
    readonly stallPercent?: { readonly cpu: number; readonly io: number };
  };
  /** The fixed scenario: rounds, concurrency, throttling. Two runs compare only on equal profiles. */
  readonly profile: Readonly<Record<string, string | number>>;
  /** Resolved nonsecret Compose settings for this side, rather than the caller's environment. */
  readonly scenario: Readonly<Record<string, string | number>> & {
    readonly workerReplicas: number;
    readonly workerConcurrency: number;
  };
  /** A deliberate configuration experiment, still excluded from regression verdicts. */
  readonly experiment: string | null;
  readonly metrics: readonly Metric[];
}

/** Parses the current persisted format once, before any stack is started. */
export function parseResult(json: string): PerfResult {
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "")
      throw new Error(`${field} must be a nonempty string`);
    return value;
  };
  const finite = (value: unknown, field: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`${field} must be a finite number`);
    return value;
  };
  const number = (value: unknown, field: string): number => {
    const parsed = finite(value, field);
    if (parsed < 0) throw new Error(`${field} must be nonnegative`);
    return parsed;
  };
  const integer = (value: unknown, field: string): number => {
    const parsed = number(value, field);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new Error(`${field} must be a positive integer`);
    return parsed;
  };
  const array = (value: unknown, field: string): unknown[] => {
    if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
    return value;
  };
  const settings = (value: unknown, field: string): Record<string, string | number> =>
    Object.fromEntries(
      Object.entries(object(value, field)).map(([key, value]) => [
        key,
        typeof value === "string" ? value : finite(value, `${field}.${key}`),
      ]),
    );
  const root = object(JSON.parse(json), "result");
  const startedAt = text(root.startedAt, "startedAt");
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("startedAt must be a date");
  const target = root.target;
  if (target !== "api" && target !== "web" && target !== "all")
    throw new Error("target must be api, web or all");
  const git = object(root.git, "git");
  const sha = text(git.sha, "git.sha");
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("git.sha must be a full commit SHA");
  if (typeof git.dirty !== "boolean") throw new Error("git.dirty must be a boolean");
  const machine = object(root.machine, "machine");
  const load = (value: unknown, field: string) => {
    const values = array(value, field).map((entry) => number(entry, field));
    if (values.length !== 3) throw new Error(`${field} must hold three load averages`);
    return values;
  };
  const stall =
    machine.stallPercent === undefined
      ? undefined
      : object(machine.stallPercent, "machine.stallPercent");
  const scenario = settings(root.scenario, "scenario");
  const profile = settings(root.profile, "profile");
  integer(profile.rounds, "profile.rounds");
  const metrics = array(root.metrics, "metrics").map((value, index): Metric => {
    const field = `metrics[${index}]`;
    const entry = object(value, field);
    const unit = entry.unit;
    if (typeof unit !== "string" || !Object.hasOwn(RESOLUTION, unit))
      throw new Error(`${field}.unit is invalid`);
    const better = entry.better;
    if (better !== "lower" && better !== "higher")
      throw new Error(`${field}.better must be lower or higher`);
    const min = number(entry.min, `${field}.min`);
    const median = number(entry.median, `${field}.median`);
    const max = number(entry.max, `${field}.max`);
    if (min > median || median > max) throw new Error(`${field} must satisfy min <= median <= max`);
    return {
      group: text(entry.group, `${field}.group`),
      name: text(entry.name, `${field}.name`),
      unit: unit as Unit,
      better,
      min,
      median,
      max,
      floor: number(entry.floor, `${field}.floor`),
      rounds: integer(entry.rounds, `${field}.rounds`),
    };
  });
  if (metrics.length === 0) throw new Error("metrics must not be empty");
  if (new Set(metrics.map(key)).size !== metrics.length)
    throw new Error("metrics contains duplicate group/name pairs");
  return {
    startedAt,
    target,
    git: { sha, dirty: git.dirty },
    machine: {
      host: text(machine.host, "machine.host"),
      cpu: text(machine.cpu, "machine.cpu"),
      cores: integer(machine.cores, "machine.cores"),
      memoryGiB: number(machine.memoryGiB, "machine.memoryGiB"),
      os: text(machine.os, "machine.os"),
      node: text(machine.node, "machine.node"),
      docker: text(machine.docker, "machine.docker"),
      loadBefore: load(machine.loadBefore, "machine.loadBefore"),
      loadAfter: load(machine.loadAfter, "machine.loadAfter"),
      ...(stall === undefined
        ? {}
        : {
            stallPercent: {
              cpu: number(stall.cpu, "machine.stallPercent.cpu"),
              io: number(stall.io, "machine.stallPercent.io"),
            },
          }),
    },
    profile,
    scenario: {
      ...scenario,
      workerConcurrency: integer(scenario.workerConcurrency, "scenario.workerConcurrency"),
      workerReplicas: integer(scenario.workerReplicas, "scenario.workerReplicas"),
    },
    experiment: root.experiment === null ? null : text(root.experiment, "experiment"),
    metrics,
  };
}

/** A metric of the head next to the same metric of the base. */
interface Delta {
  readonly base: Metric;
  readonly head: Metric;
  /** head.median - base.median */
  readonly delta: number;
  /** The larger range or floor of the two, at least the unit's resolution: a delta inside it is no measured difference. */
  readonly spread: number;
  readonly verdict: Verdict;
}

type Verdict = "better" | "worse" | "same";

/** A scenario entry base and head set differently, or only one of them sets. */
interface ScenarioDifference {
  readonly name: string;
  readonly base: string | number | undefined;
  readonly head: string | number | undefined;
}

/**
 * What compare judged, and what it could not: metrics one side lacks or defines differently. Runs
 * of different scenarios are not judged at all, because the scenario moves every number.
 */
type Comparison =
  | {
      readonly kind: "judged";
      readonly deltas: readonly Delta[];
      readonly onlyBase: readonly Metric[];
      readonly onlyHead: readonly Metric[];
      /** Same group and name, another unit or direction: a delta between them would mean nothing. */
      readonly redefined: readonly { readonly base: Metric; readonly head: Metric }[];
    }
  | { readonly kind: "other scenario"; readonly differences: readonly ScenarioDifference[] };

/** The value at quantile `q` (0..1) of `values`, by nearest rank. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error("quantile of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1] as number;
}

/** Folds the per-round values of one metric into its median and range. */
function metric(
  group: string,
  name: string,
  unit: Unit,
  better: Better,
  values: readonly number[],
  floor: number,
): Metric {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return {
    better,
    floor,
    group,
    max: sorted.at(-1) as number,
    median,
    min: sorted[0] as number,
    name,
    rounds: values.length,
    unit,
  };
}

/**
 * Collects one value per metric per round and folds them into metrics in the order they were
 * first recorded, which is the order the summary prints.
 */
export class Rounds {
  readonly #values = new Map<
    string,
    {
      readonly entry: Pick<Metric, "group" | "name" | "unit" | "better">;
      readonly values: number[];
      floor: number;
    }
  >();

  /**
   * `floor` is this round's share of `value` that the start of the run decides, see Metric. Throws
   * on a value that is not a finite number: JSON would store it as null and spoil a later compare.
   */
  record(group: string, name: string, unit: Unit, better: Better, value: number, floor = 0): void {
    if (!Number.isFinite(value) || !Number.isFinite(floor)) {
      throw new Error(
        `${group} ${name} measured ${value} ${unit} with floor ${floor}, not a number.`,
      );
    }
    const id = `${group}\u0000${name}`;
    const known = this.#values.get(id);
    if (known === undefined)
      this.#values.set(id, { entry: { better, group, name, unit }, floor, values: [value] });
    else {
      known.values.push(value);
      known.floor = Math.max(known.floor, floor);
    }
  }

  metrics(): Metric[] {
    return [...this.#values.values()].map(({ entry, floor, values }) =>
      metric(entry.group, entry.name, entry.unit, entry.better, values, floor),
    );
  }
}

/**
 * The smallest difference a unit resolves. Memory of an idle service drifts by KiB and a count
 * moves in whole steps, so a delta this small is no difference even when every round agreed.
 */
const RESOLUTION: Readonly<Record<Unit, number>> = {
  count: 1,
  "cpu-s": 0.01,
  KiB: 1,
  MiB: 1,
  ms: 1,
  "req/s": 1,
  "runs/s": 0.01,
  s: 0.1,
  score: 0.001,
};

const key = (entry: Metric) => `${entry.group}\u0000${entry.name}`;

function verdict(delta: number, spread: number, better: Better): Verdict {
  if (Math.abs(delta) <= spread) return "same";
  const improved = better === "lower" ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

function scenarioDifferences(base: PerfResult, head: PerfResult): ScenarioDifference[] {
  const configuration = (result: PerfResult) => ({
    ...result.profile,
    ...Object.fromEntries(
      Object.entries(result.scenario).map(([key, value]) => [`stack.${key}`, value]),
    ),
  });
  const before = configuration(base);
  const after = configuration(head);
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => before[name] !== after[name])
    .map((name) => ({ base: before[name], head: after[name], name }));
}

/**
 * Pairs the metrics both results hold with the same unit and direction and judges each delta
 * against the spread: the larger range or floor of the two, at least the unit's resolution.
 * Judges nothing when the two ran different scenarios.
 */
export function compare(base: PerfResult, head: PerfResult): Comparison {
  const differences = scenarioDifferences(base, head);
  if (differences.length > 0) return { differences, kind: "other scenario" };
  const baseline = new Map(base.metrics.map((entry) => [key(entry), entry]));
  const headKeys = new Set(head.metrics.map(key));
  const deltas: Delta[] = [];
  const onlyHead: Metric[] = [];
  const redefined: { base: Metric; head: Metric }[] = [];
  for (const current of head.metrics) {
    const before = baseline.get(key(current));
    if (before === undefined) {
      onlyHead.push(current);
    } else if (before.unit !== current.unit || before.better !== current.better) {
      redefined.push({ base: before, head: current });
    } else {
      const delta = current.median - before.median;
      const spread = Math.max(
        before.max - before.min,
        current.max - current.min,
        before.floor,
        current.floor,
        RESOLUTION[current.unit],
      );
      deltas.push({
        base: before,
        delta,
        head: current,
        spread,
        verdict: verdict(delta, spread, current.better),
      });
    }
  }
  const onlyBase = base.metrics.filter((entry) => !headKeys.has(key(entry)));
  return { deltas, kind: "judged", onlyBase, onlyHead, redefined };
}

function format(value: number, unit: Unit): string {
  switch (unit) {
    case "score":
      return value.toFixed(3);
    case "cpu-s":
    case "s":
    case "runs/s":
      return value.toFixed(2);
    case "ms":
    case "MiB":
      return Math.abs(value) < 100 ? value.toFixed(1) : value.toFixed(0);
    default:
      return value.toFixed(0);
  }
}

/** Left-aligns the first column and right-aligns the rest. */
function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths?.[column] ?? 0) : cell.padStart(widths?.[column] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** Groups with the same columns share one table; groups and tables keep the order measured. */
function sections(metrics: readonly Metric[]): Metric[][][] {
  const groups = new Map<string, Metric[]>();
  for (const entry of metrics) {
    const group = groups.get(entry.group);
    if (group === undefined) groups.set(entry.group, [entry]);
    else group.push(entry);
  }
  const tables = new Map<string, Metric[][]>();
  for (const group of groups.values()) {
    const columns = group.map((entry) => entry.name).join("\u0000");
    const table = tables.get(columns);
    if (table === undefined) tables.set(columns, [group]);
    else table.push(group);
  }
  return [...tables.values()];
}

function header(result: PerfResult): string {
  const { machine, git } = result;
  const load = (values: readonly number[]) => values.map((value) => value.toFixed(1)).join(" ");
  return [
    `${git.sha.slice(0, 12)}${git.dirty ? "+dirty" : ""} at ${result.startedAt}, target ${result.target}`,
    `${machine.host}: ${machine.cores} x ${machine.cpu}, ${machine.memoryGiB} GiB, ${machine.os}, node ${machine.node}, docker ${machine.docker}`,
    `workers: ${result.scenario.workerReplicas} replicas, WORKER_CONCURRENCY=${result.scenario.workerConcurrency}${result.experiment === null ? "" : `; configuration experiment: ${result.experiment}`}`,
    `load ${load(machine.loadBefore)} before, ${load(machine.loadAfter)} after (1/5/15 min)${
      machine.stallPercent === undefined
        ? ""
        : `; tasks stalled on CPU ${machine.stallPercent.cpu.toFixed(1)}%, on IO ${machine.stallPercent.io.toFixed(1)}% of the time`
    }`,
  ].join("\n");
}

/** The tables a person reads after a run: each cell is the median and the range of the rounds. */
export function summarize(result: PerfResult): string {
  const rounds = Math.max(...result.metrics.map((entry) => entry.rounds));
  const tables = sections(result.metrics).map((section) => {
    const header = ["", ...(section[0] ?? []).map((entry) => `${entry.name} ${entry.unit}`)];
    const rows = section.map((group) => [
      group[0]?.group ?? "",
      ...group.map(
        (entry) =>
          `${format(entry.median, entry.unit)} [${format(entry.min, entry.unit)}-${format(entry.max, entry.unit)}]`,
      ),
    ]);
    return table([header, ...rows]);
  });
  return [
    header(result),
    `Each cell: median [min-max] of ${rounds} rounds.`,
    "",
    tables.join("\n\n"),
  ].join("\n");
}

/** A warning when base and head ran on different machines, whose numbers differ for that alone. */
function otherMachine(base: PerfResult, head: PerfResult): string[] {
  return base.machine.host !== head.machine.host || base.machine.cpu !== head.machine.cpu
    ? [`warning: base ran on ${base.machine.host}, head on ${head.machine.host}`]
    : [];
}

/** The groups of `metrics` in the order measured, for a line that names what was not compared. */
function groupsOf(metrics: readonly Metric[]): string {
  return [...new Set(metrics.map((entry) => entry.group))].join(", ");
}

/** The compare table: base and head medians, the delta, the spread it is judged against, the verdict. */
export function formatComparison(base: PerfResult, head: PerfResult): string {
  const headers = [
    `base ${header(base).replaceAll("\n", "\n     ")}`,
    `head ${header(head).replaceAll("\n", "\n     ")}`,
    ...otherMachine(base, head),
  ];
  const comparison = compare(base, head);
  if (comparison.kind === "other scenario") {
    return [
      ...headers,
      ...comparison.differences.map(
        ({ name, base: before, head: current }) =>
          `scenario ${name}: base ${before ?? "unset"}, head ${current ?? "unset"}`,
      ),
      "",
      "not compared: base and head ran different scenarios, so every number may differ for that alone. Measure the base again with this checkout, for example with --against.",
    ].join("\n");
  }
  const { deltas, onlyBase, onlyHead, redefined } = comparison;
  const rows = deltas.map(({ base: before, delta, head: current, spread, verdict }) => {
    const percent =
      Math.abs(before.median) < RESOLUTION[before.unit]
        ? ""
        : ` (${delta >= 0 ? "+" : ""}${((delta / before.median) * 100).toFixed(0)}%)`;
    return [
      `${current.group} ${current.name}`,
      format(before.median, before.unit),
      format(current.median, current.unit),
      `${delta >= 0 ? "+" : ""}${format(delta, current.unit)}${percent}`,
      format(spread, current.unit),
      current.unit,
      verdict === "same" ? "same" : verdict.toUpperCase(),
    ];
  });
  const count = (verdict: Verdict) => deltas.filter((entry) => entry.verdict === verdict).length;
  const judged =
    deltas.length === 0
      ? ["warning: base and head share no metric, so nothing was compared."]
      : [
          table([["metric", "base", "head", "delta", "spread", "unit", "verdict"], ...rows]),
          "",
          `${count("better")} better, ${count("worse")} worse, ${count("same")} same within the spread.`,
        ];
  const unjudged = [
    ...(onlyBase.length === 0
      ? []
      : [`not compared: ${onlyBase.length} metrics only in base: ${groupsOf(onlyBase)}`]),
    ...(onlyHead.length === 0
      ? []
      : [`not compared: ${onlyHead.length} metrics only in head: ${groupsOf(onlyHead)}`]),
    ...redefined.map(
      ({ base: before, head: current }) =>
        `not compared: ${current.group} ${current.name} is ${before.unit}, ${before.better} is better in base and ${current.unit}, ${current.better} is better in head`,
    ),
  ];
  return [
    ...headers,
    "A delta inside the spread (the larger min-max range of base and head, for memory at least what the kernel handed the service in huge pages, and at least the unit's resolution) is no measured difference.",
    "",
    ...judged,
    ...unjudged,
  ].join("\n");
}

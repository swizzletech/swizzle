// `just perf`: measures the speed and resource use of the packaged stack, backend and frontend.
//   just perf [api|web] [--against <git ref> | --base <result.json>] [--experiment <label>]
// Boots a throwaway packaged stack (scripts/packaged-stack.mts) with production images, seeds it
// with the same data every time, measures the dashboard pages, the api routes and the run
// lifecycle, each in rounds after a warmup, and removes the stack. With --against it also unpacks
// the ref's committed tree into a temp directory and boots a second stack from it; each round then
// measures both stacks, in an order that flips every round, so base and head share the host's
// noise. This checkout's measuring code and CLI drive both stacks. stdout gets the summary, or the
// delta to the base judged against the spread; results land as JSON under
// `git rev-parse --git-path swizzle-perf`. Progress goes to stderr.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanUpOnSignal,
  type PackagedStack,
  startPackagedStack,
  throwawayPrefix,
} from "./packaged-stack.mts";
import {
  API_PROFILE,
  deployRound,
  routeRound,
  runRound,
  triggerRun,
  waitForRun,
  warmRoutes,
} from "./perf/api.mts";
import type { Service } from "./perf/resources.mts";
import {
  compare,
  formatComparison,
  type PerfResult,
  parseResult,
  Rounds,
  summarize,
  type Target,
} from "./perf/result.ts";
import { stackScenario } from "./perf/scenario.mts";
import { launchBrowser, WEB_PROFILE, warmWeb, webRound } from "./perf/web.mts";

const ROUNDS = 5;
/** Webhook examples only: a cron example would add runs on its own schedule. */
const SEED_EXAMPLES = [
  "hello-webhook",
  "document-scanner",
  "webhook-transformer",
  "typescript-webhook",
];
/** Runs of the reference automation the pages and the run-detail route read. */
const SEED_RUNS = 12;

const USAGE =
  "usage: just perf [api|web] [--against <git ref> | --base <result.json>] [--experiment <label>]";

/** What the run compares with: nothing, a stored result, or a commit measured alongside. */
type Base =
  | { readonly kind: "none" }
  | { readonly kind: "result"; readonly result: PerfResult }
  | { readonly kind: "commit"; readonly sha: string };

interface Options {
  readonly target: Target;
  readonly base: Base;
  readonly experiment: string | null;
}

class UsageError extends Error {}

async function parseOptions(argv: readonly string[]): Promise<Options> {
  let target: Target = "all";
  let experiment: string | null = null;
  let basePath: string | undefined;
  let ref: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "api" || argument === "web") target = argument;
    else if (argument === "--base" && value !== undefined) {
      basePath = value;
      index += 1;
    } else if (argument === "--against" && value !== undefined) {
      ref = value;
      index += 1;
    } else if (argument === "--experiment" && value !== undefined && value.trim() !== "") {
      experiment = value;
      index += 1;
    } else throw new UsageError(`unknown argument ${argument}`);
  }
  if (basePath !== undefined && ref !== undefined) {
    throw new UsageError("--base and --against exclude each other");
  }
  if (ref !== undefined) {
    try {
      return {
        base: { kind: "commit", sha: git("rev-parse", "--verify", `${ref}^{commit}`) },
        target,
        experiment,
      };
    } catch {
      throw new UsageError(`--against ${ref} names no commit`);
    }
  }
  if (basePath === undefined) return { base: { kind: "none" }, target, experiment };
  try {
    const result = parseResult(await readFile(basePath, "utf8"));
    return { base: { kind: "result", result }, target, experiment };
  } catch (error) {
    throw new UsageError(
      `cannot read the base result ${basePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function log(message: string): void {
  process.stderr.write(`perf: ${message}\n`);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The containers of the stack's long-running services, as compose names them. */
async function services(stack: PackagedStack): Promise<Service[]> {
  const lines = (await stack.compose("ps", "--format", "json")).split("\n").filter(Boolean);
  return lines
    .map((line) => JSON.parse(line) as { Service: string; ID: string })
    .map((entry) => ({ containerId: entry.ID, name: entry.Service }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Deploys the examples and runs the reference automation SEED_RUNS times; returns the last run. */
async function seed(stack: PackagedStack): Promise<string> {
  for (const example of SEED_EXAMPLES) await stack.cli("apply", `infra/examples/${example}`);
  let runId = "";
  for (let index = 0; index < SEED_RUNS; index += 1) {
    ({ runId } = await triggerRun(stack, { seed: index }));
    const run = await waitForRun(stack, runId);
    if (run.status !== "succeeded") throw new Error(`Seed run ${runId} ended ${run.status}.`);
  }
  log(`seeded ${SEED_EXAMPLES.length} automations and ${SEED_RUNS} runs`);
  return runId;
}

/** Microseconds some task stalled on CPU and on IO since boot (Linux PSI); undefined elsewhere. */
function stalls(): { readonly cpu: number; readonly io: number } | undefined {
  const total = (resource: string) => {
    const text = readFileSync(`/proc/pressure/${resource}`, "utf8");
    return Number(/^some .*total=(\d+)/mu.exec(text)?.[1]);
  };
  try {
    return { cpu: total("cpu"), io: total("io") };
  } catch {
    return undefined;
  }
}

/** The load and stall counters at one moment, so the measured span can be described. */
function snapshot() {
  return { load: os.loadavg(), stalls: stalls(), time: performance.now() };
}

function machine(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  const [cpu] = os.cpus();
  const span = (after.time - before.time) * 1000;
  const share = (resource: "cpu" | "io") =>
    before.stalls === undefined || after.stalls === undefined
      ? undefined
      : (100 * (after.stalls[resource] - before.stalls[resource])) / span;
  const [cpuStall, ioStall] = [share("cpu"), share("io")];
  return {
    cores: os.availableParallelism(),
    cpu: cpu?.model.trim() ?? "unknown",
    docker: execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      encoding: "utf8",
    }).trim(),
    host: os.hostname(),
    loadAfter: after.load,
    loadBefore: before.load,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    ...(cpuStall === undefined || ioStall === undefined
      ? {}
      : { stallPercent: { cpu: cpuStall, io: ioStall } }),
  };
}

/** A stack under measurement, the commit it was built from and the rounds measured on it. */
interface Session {
  readonly name: "base" | "head";
  readonly git: PerfResult["git"];
  readonly stack: PackagedStack;
  readonly services: readonly Service[];
  readonly seedRunId: string;
  readonly rounds: Rounds;
  readonly scenario: PerfResult["scenario"];
}

/** The committed tree of `sha` in a new temp directory; the caller removes it. */
async function unpack(sha: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), `${throwawayPrefix("perf")}${sha.slice(0, 8)}-`),
  );
  cleanUpOnSignal(() => rm(directory, { force: true, recursive: true }));
  const archive = execFileSync("git", ["archive", "--format=tar", sha], { maxBuffer: 2 ** 30 });
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  return directory;
}

/**
 * Warms every session, then measures ROUNDS rounds; each round measures every session once, and
 * the order flips every round, so a slow moment of the host and the cost of going first or second
 * fall on base and head alike.
 */
async function interleave(
  sessions: readonly Session[],
  label: string,
  warm: (session: Session) => Promise<void>,
  round: (session: Session, index: number) => Promise<void>,
): Promise<void> {
  for (const session of sessions) await warm(session);
  for (let index = 1; index <= ROUNDS; index += 1) {
    const order = index % 2 === 1 ? sessions : sessions.toReversed();
    for (const session of order) {
      const on = sessions.length > 1 ? ` on ${session.name}` : "";
      log(`${label} round ${index}/${ROUNDS}${on}`);
      await round(session, index);
    }
  }
}

/**
 * The pages first and the routes second, so both read only the seed; the run lifecycle last,
 * because it adds runs. Each run lifecycle round deploys a new version of the reference automation
 * and measures its first run, then the runs after it.
 */
async function measureSessions(sessions: readonly Session[], target: Target): Promise<void> {
  if (target !== "api") {
    const browser = await launchBrowser();
    try {
      await interleave(
        sessions,
        "web",
        (session) => warmWeb(browser, session.stack),
        (session) => webRound(browser, session.stack, session.rounds),
      );
    } finally {
      await browser.close();
    }
  }
  if (target !== "web") {
    await interleave(
      sessions,
      "api routes",
      (session) => warmRoutes(session.stack, session.seedRunId),
      (session) => routeRound(session.stack, session.services, session.seedRunId, session.rounds),
    );
    await interleave(
      sessions,
      "run lifecycle",
      async () => undefined,
      async (session, index) => {
        await deployRound(session.stack, session.services, index, session.rounds);
        await runRound(session.stack, session.services, index, session.rounds);
      },
    );
  }
}

/** Measures this checkout, and with --against the base commit beside it; returns one result each. */
async function measure(
  options: Options,
): Promise<{ readonly head: PerfResult; readonly base?: PerfResult }> {
  const startedAt = new Date().toISOString();
  const checkout = {
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    sha: git("rev-parse", "HEAD"),
  };
  const stacks: PackagedStack[] = [];
  let tree: string | undefined;
  const boot = async (name: Session["name"], root: string, commit: Session["git"]) => {
    log(`booting the ${name} stack from ${commit.sha.slice(0, 12)}${commit.dirty ? "+dirty" : ""}`);
    const stack = await startPackagedStack("perf", log, root);
    stacks.push(stack);
    const seedRunId = await seed(stack);
    const session: Session = {
      git: commit,
      name,
      rounds: new Rounds(),
      scenario: stackScenario(await stack.compose("config", "--format", "json")),
      seedRunId,
      services: await services(stack),
      stack,
    };
    return session;
  };
  try {
    let base: Session | undefined;
    if (options.base.kind === "commit") {
      tree = await unpack(options.base.sha);
      base = await boot("base", tree, { dirty: false, sha: options.base.sha });
    }
    const head = await boot("head", ".", checkout);
    const sessions = base === undefined ? [head] : [base, head];
    const before = snapshot();
    await measureSessions(sessions, options.target);
    const shared = {
      machine: machine(before, snapshot()),
      profile: { rounds: ROUNDS, seedRuns: SEED_RUNS, ...API_PROFILE, ...WEB_PROFILE },
      startedAt,
      target: options.target,
    };
    const result = (session: Session): PerfResult => ({
      ...shared,
      git: session.git,
      scenario: session.scenario,
      experiment: options.experiment,
      metrics: session.rounds.metrics(),
    });
    return base === undefined ? { head: result(head) } : { base: result(base), head: result(head) };
  } finally {
    for (const stack of stacks.toReversed()) await stack.remove();
    if (tree !== undefined) await rm(tree, { force: true, recursive: true });
  }
}

/** Writes `result` under the worktree's git directory and returns the file. */
async function write(result: PerfResult, name: Session["name"]): Promise<string> {
  const directory = git("rev-parse", "--path-format=absolute", "--git-path", "swizzle-perf");
  await mkdir(directory, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/gu, "-");
  const suffix = name === "base" ? "-base" : "";
  const file = path.join(
    directory,
    `${stamp}-${result.target}-${result.git.sha.slice(0, 12)}${suffix}.json`,
  );
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let options: Options;
  try {
    options = await parseOptions(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stdout.write(`error: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  const { base, head } = await measure(options);
  const file = await write(head, "head");
  const baseline = base ?? (options.base.kind === "result" ? options.base.result : undefined);
  const baseFile = base === undefined ? undefined : await write(base, "base");
  const report = baseline === undefined ? summarize(head) : formatComparison(baseline, head);
  process.stdout.write(
    `${report}\n\n${baseFile === undefined ? "" : `base: ${baseFile}\n`}result: ${file}\n`,
  );
  if (
    baseline !== undefined &&
    compare(baseline, head).kind === "other scenario" &&
    options.experiment === null
  ) {
    process.stdout.write(
      "error: different performance scenarios; use --experiment <label> for a deliberate configuration experiment.\n",
    );
    return 1;
  }
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});

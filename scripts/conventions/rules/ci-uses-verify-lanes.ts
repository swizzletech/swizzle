import { forEachChild, parse as parseShell, type SyntaxNode } from "unbash";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { Rule, Violation } from "../lint.js";
import { shellCommands } from "../parse.js";

const CI = ".github/workflows/ci.yml";
const CI_ONLY = new Map([["audit", "it reads the live advisory feed"]]);

export const ciUsesVerifyLanes: Rule = {
  id: "ci-uses-verify-lanes",
  check(repo) {
    const hasWorkflow = repo.exists(CI);
    const recipes = repo.recipes();
    const verify = recipes.find(({ name }) => name === "verify");
    if (!verify && !hasWorkflow) return [];
    if (!verify || verify.dependencies.length === 0 || verify.script !== "") {
      return [
        {
          file: "justfile",
          line: verify?.line ?? 1,
          message: "Define `verify` with lane recipe dependencies and no commands of its own.",
        },
      ];
    }

    const lanes = new Set(verify.dependencies);
    const parameterized = new Set(
      recipes.filter(({ parameters }) => parameters.length > 0).map(({ name }) => name),
    );
    const lineCounter = new LineCounter();
    const workflow = parseDocument(hasWorkflow ? repo.read(CI) : "", { lineCounter });
    const resolve = (node: unknown) => (isAlias(node) ? node.resolve(workflow) : node);
    const shellValue = (node: unknown) => {
      const scalar = resolve(node);
      return isScalar(scalar) && typeof scalar.value === "string" ? scalar.value : undefined;
    };
    const defaultShell = (owner: unknown) => {
      const defaults = isMap(owner) ? resolve(owner.get("defaults")) : undefined;
      const run = isMap(defaults) ? resolve(defaults.get("run")) : undefined;
      return isMap(run) ? shellValue(run.get("shell", true)) : undefined;
    };
    const workflowShell = defaultShell(workflow.contents);
    const definitions = workflow.get("jobs");
    const jobs = isMap(definitions) ? definitions.items : [];
    const needs = workflow.getIn(["jobs", "verify", "needs"]);
    const requiredJobs = isSeq(needs)
      ? needs.items.map((id) => (isScalar(id) ? id.value : id))
      : [needs];
    const scheduled = new Set<string>();
    const testShards: (string | undefined)[] = [];
    const findings: Violation[] = [];

    for (const { key, value: job } of jobs) {
      if (!isScalar(key) || typeof key.value !== "string" || !isMap(job)) continue;
      const id = key.value;
      const line = lineCounter.linePos(key.range?.[0] ?? 0).line;
      const report = (message: string) => findings.push({ file: CI, line, message });
      const steps = resolve(job.get("steps"));
      const required = requiredJobs.includes(id);
      const jobShell = defaultShell(job) ?? workflowShell;
      const calls = isSeq(steps)
        ? steps.items.flatMap((step) => {
            if (!isMap(step)) return [];
            const run = step.get("run");
            if (
              required &&
              (allowsFailure(step) || (typeof run === "string" && masksFailure(parseShell(run))))
            ) {
              report(`Job ${id} must preserve required step failures.`);
            }
            if (typeof run !== "string") return [];
            const shell = shellValue(step.get("shell", true)) ?? jobShell;
            if (required && shell !== undefined && bashLacksErrexit(shell)) {
              report(
                `Job ${id} uses Bash without errexit. Use \`shell: bash\` or enable errexit in the shell template.`,
              );
            }
            const shardEnv = step.getIn(["env", "SHARD"]) ?? job.getIn(["env", "SHARD"]);
            return shellCommands(run).map((call) => ({ ...call, shardEnv }));
          })
        : [];
      if (required && allowsFailure(job)) report(`Job ${id} must preserve required failures.`);
      let laneCount = 0;
      let hasUnknownRecipe = false;
      for (const {
        words: [command, recipe, ...args],
        shardEnv,
      } of calls) {
        if (command !== "just" || recipe === undefined) continue;
        if (lanes.has(recipe)) {
          laneCount += 1;
          if (id !== "verify") scheduled.add(recipe);
          if (required && recipe === "test") {
            const flag = args.findIndex((arg) => arg === "--shard" || arg.startsWith("--shard="));
            const value = flag < 0 ? undefined : (args[flag]?.split("=")[1] ?? args[flag + 1]);
            const shard = /^\$(?:SHARD|\{SHARD\})$/u.test(value ?? "") ? shardEnv : value;
            testShards.push(typeof shard === "string" ? shard : flag < 0 ? undefined : "");
          }
        } else if (!CI_ONLY.has(recipe)) {
          hasUnknownRecipe = true;
          report(
            `Job ${id} runs \`just ${recipe}\` outside the verify lanes. Use a lane from \`just verify\` or add the recipe to one.`,
          );
          continue;
        }
        if (!parameterized.has(recipe) && args.length > 0) {
          report(`Run \`just ${recipe}\` on its own so one command cannot invoke extra recipes.`);
        }
      }
      if (id === "verify") {
        if (laneCount > 0) report("Run verification lanes in the jobs listed in Verify's needs.");
        continue;
      }
      if (!hasUnknownRecipe && laneCount !== 1) {
        report(`Job ${id} must run exactly one recipe listed in \`just verify\`.`);
      }
      if (!required) {
        report(`Add job ${id} to Verify's needs so its result is required.`);
      }
    }
    for (const lane of lanes) {
      if (scheduled.has(lane)) continue;
      findings.push({
        file: CI,
        line: 1,
        message: `Missing CI job for verify lane ${lane}. Run \`just ${lane}\` in a job listed in Verify's needs.`,
      });
    }
    if (!coversTestShards(testShards)) {
      findings.push({
        file: CI,
        line: 1,
        message: "Required test jobs must cover every shard index once with a common denominator.",
      });
    }
    return findings;
  },
};

function bashLacksErrexit(shell: string): boolean {
  const [command, ...options] = shell.trim().split(/\s+/u);
  if (
    !command ||
    !/(^|[/\\])bash(?:\.exe)?$/iu.test(command) ||
    (command === "bash" && options.length === 0)
  ) {
    return false;
  }

  return !options.some(
    (option, index) =>
      /^-[a-zA-Z]*e[a-zA-Z]*$/u.test(option) ||
      (option === "-o" && options[index + 1] === "errexit"),
  );
}

function allowsFailure(node: unknown): boolean {
  if (!isMap(node)) return false;
  const value = node.get("continue-on-error");
  return value !== undefined && value !== false;
}

function masksFailure(node: SyntaxNode): boolean {
  if (
    node.type === "AndOr" &&
    node.operators.some((operator, index) => {
      const fallback = node.commands[index + 1];
      return (
        operator === "||" &&
        fallback?.type === "Command" &&
        (fallback.name?.value === "true" || fallback.name?.value === ":")
      );
    })
  )
    return true;
  let found = false;
  forEachChild(node, (child) => {
    if (!found) found = masksFailure(child);
  });
  return found;
}

function coversTestShards(shards: readonly (string | undefined)[]): boolean {
  if (shards.length === 0 || (shards.length === 1 && shards[0] === undefined)) return true;
  const indices = shards.map((shard) => {
    const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(shard ?? "");
    return Number(match?.[2]) === shards.length ? Number(match?.[1]) : NaN;
  });
  return (
    new Set(indices).size === shards.length &&
    indices.every((index) => Number.isSafeInteger(index) && index <= shards.length)
  );
}

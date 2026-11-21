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
    const definitions = workflow.get("jobs");
    const jobs = isMap(definitions) ? definitions.items : [];
    const needs = workflow.getIn(["jobs", "verify", "needs"]);
    const requiredJobs = isSeq(needs)
      ? needs.items.map((id) => (isScalar(id) ? id.value : id))
      : [needs];
    const scheduled = new Set<string>();
    const findings: Violation[] = [];

    for (const { key, value: job } of jobs) {
      if (!isScalar(key) || typeof key.value !== "string" || !isMap(job)) continue;
      const id = key.value;
      const line = lineCounter.linePos(key.range?.[0] ?? 0).line;
      const report = (message: string) => findings.push({ file: CI, line, message });
      const rawSteps = job.get("steps");
      const steps = isAlias(rawSteps) ? rawSteps.resolve(workflow) : rawSteps;
      const calls = isSeq(steps)
        ? steps.items.flatMap((step) => {
            const run = isMap(step) ? step.get("run") : undefined;
            return typeof run === "string" ? shellCommands(run) : [];
          })
        : [];
      let laneCount = 0;
      let hasUnknownRecipe = false;
      for (const {
        words: [command, recipe, ...args],
      } of calls) {
        if (command !== "just" || recipe === undefined) continue;
        if (lanes.has(recipe)) {
          laneCount += 1;
          if (id !== "verify") scheduled.add(recipe);
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
      if (!requiredJobs.includes(id)) {
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
    return findings;
  },
};

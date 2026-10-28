import { execFile } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { expect, it, vi } from "vitest";
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { temporaryDirectory } from "../test/support.js";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("..", import.meta.url));

async function fixture(unaffectedExpected = 42) {
  const root = await temporaryDirectory("swizzle-affected-");
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"), { recursive: true });
  await mkdir(path.join(root, "node_modules"));
  for (const name of ["vitest", "tsx"]) {
    await symlink(
      path.join(source, "node_modules", name),
      path.join(root, "node_modules", name),
      "junction",
    );
  }
  const files = {
    ".gitignore": "node_modules\nexecutions.log\n",
    "package.json": '{"type":"module"}',
    "test/inputs.json": "{}",
    "vitest.config.ts": 'export default { test: { include: ["*.test.ts"], maxWorkers: 1 } };',
    "src/core.ts": "export const value = 42;",
    "src/dependant.ts": 'export { value } from "./core.js";',
    "direct.test.ts":
      'import { it, expect } from "vitest"; import { value } from "./src/core.js"; import { appendFileSync } from "node:fs"; it("direct", () => { appendFileSync("executions.log", "direct\\n"); expect(value).toBe(42); });',
    "transitive.test.ts":
      'import { it, expect } from "vitest"; import { value } from "./src/dependant.js"; it("transitive", () => expect(value).toBe(42));',
    "unaffected.test.ts": `import { it, expect } from "vitest"; it("unaffected", () => expect(6 * 7).toBe(${unaffectedExpected}));`,
  };
  for (const [file, content] of Object.entries(files))
    await writeFile(path.join(root, file), content);
  await exec("git", ["init", "--quiet"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@swizzle.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  const run = (...args: string[]) =>
    exec(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(source, "scripts/affected-tests.mts"),
        "--base",
        "HEAD",
        ...args,
      ],
      { cwd: root, env: { ...process.env, NODE_ENV: "test" } },
    );
  return { root, run };
}

it("selects direct and transitive consumers, reuses green content, and reruns a changed input", async () => {
  const { root, run } = await fixture();
  await writeFile(path.join(root, "src/core.ts"), "export const value = 42;\n");
  const first = await run();
  expect(first.stdout).toContain("selected: 2 of 3 test files");
  expect(first.stdout).toContain("saved green results for 2 test files");
  expect(await readFile(path.join(root, "executions.log"), "utf8")).toBe("direct\n");
  expect((await run()).stdout).toContain("reused green results for 2 test files");
  expect(await readFile(path.join(root, "executions.log"), "utf8")).toBe("direct\n");
  await writeFile(path.join(root, "src/core.ts"), "export const value = 42;\n\n");
  expect((await run()).stdout).toContain("saved green results for 2 test files");
  expect(await readFile(path.join(root, "executions.log"), "utf8")).toBe("direct\ndirect\n");
  await writeFile(path.join(root, "src/core.ts"), "export const value = 0;");
  await expect(run()).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("2 failed"),
  });
  await expect(run()).rejects.toMatchObject({
    code: 1,
    stdout: expect.not.stringContaining("reused green"),
  });
});

it("forces the full suite for shared config, support, lockfiles and deleted inputs", async () => {
  const { root, run } = await fixture();
  for (const file of ["vitest.config.ts", "test/support.ts", "pnpm-lock.yaml"]) {
    if (file.startsWith("test/")) await mkdir(path.join(root, "test"), { recursive: true });
    const previous =
      file === "vitest.config.ts" ? await readFile(path.join(root, file), "utf8") : "";
    await writeFile(path.join(root, file), `${previous}\n`);
    const { stdout } = await run("--list");
    expect(stdout).toContain("selected: 3 of 3 test files");
    expect(stdout).toContain("unaffected.test.ts");
    await exec("git", ["add", "."], { cwd: root });
    await exec(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@swizzle.test",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "shared input",
      ],
      { cwd: root },
    );
  }
  await writeFile(path.join(root, "src/unmapped.ts"), "export const notImported = 1;");
  expect((await run("--list")).stdout).toContain("selected: 3 of 3 test files");
  await exec("git", ["rm", "src/dependant.ts"], { cwd: root });
  expect((await run("--list")).stdout).toContain("selected: 3 of 3 test files");
});

it("rejects unknown arguments and runs everything when the comparison is unavailable", async () => {
  const { run } = await fixture();
  await expect(run("--shrad", "1/3")).rejects.toMatchObject({
    code: 2,
    stdout: expect.stringContaining("--shard"),
  });
  await expect(run("--shard", "4/3")).rejects.toMatchObject({
    code: 2,
    stdout: expect.stringContaining("1 <= index <= count"),
  });
  expect((await run("--base", "missing-revision", "--list")).stdout).toContain(
    "selected: 3 of 3 test files",
  );
});

it("does not save green results when inputs change during execution or teardown fails", async () => {
  const { root, run } = await fixture();
  await writeFile(
    path.join(root, "direct.test.ts"),
    'import { it, expect } from "vitest"; import { value } from "./src/core.js"; import { writeFileSync } from "node:fs"; it("edits an input", () => { writeFileSync("src/core.ts", "export const value = 42; // changed"); expect(value).toBe(42); });',
  );
  expect((await run()).stdout).toContain("inputs changed during the run; results were not saved");
  expect((await run()).stdout).toContain("saved green results for 2 test files");
  expect((await run()).stdout).toContain("reused green results for 2 test files");

  const teardown = await fixture();
  await writeFile(
    path.join(teardown.root, "teardown.ts"),
    'export default () => () => { throw new Error("teardown proof"); };',
  );
  await writeFile(
    path.join(teardown.root, "vitest.config.ts"),
    'export default { test: { include: ["*.test.ts"], maxWorkers: 1, globalSetup: ["./teardown.ts"] } };',
  );
  await expect(teardown.run()).rejects.toMatchObject({ code: 1 });
  await expect(teardown.run()).rejects.toMatchObject({
    code: 1,
    stdout: expect.not.stringContaining("reused green"),
  });
});

it("shards after selection and permits an empty shard", async () => {
  const { root, run } = await fixture();
  await writeFile(path.join(root, "src/core.ts"), "export const value = 42;\n");
  const outputs = await Promise.all(
    [1, 2, 3].map(async (index) => (await run("--shard", `${index}/3`, "--list")).stdout),
  );
  const selected = outputs.flatMap((output) =>
    output.split("\n").filter((line) => line.endsWith(".test.ts")),
  );
  expect(selected.sort()).toEqual(["direct.test.ts", "transitive.test.ts"]);
  expect((await run("--shard", "3/3")).stdout).toContain("selected: 0 of 3 test files");
});

it("keeps documentation beside a code change from forcing unrelated tests", async () => {
  const { root, run } = await fixture();
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "docs"));
  await writeFile(
    path.join(root, "scripts/agent-reference-drift.test.ts"),
    'import { it, expect } from "vitest"; it("documentation", () => expect(6 * 7).toBe(42));',
  );
  await writeFile(path.join(root, "docs/guide.md"), "# Guide\n");
  await writeFile(
    path.join(root, "vitest.config.ts"),
    'export default { test: { include: ["**/*.test.ts"], maxWorkers: 1 } };',
  );
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@swizzle.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "documentation fixture",
    ],
    { cwd: root },
  );
  await writeFile(path.join(root, "docs/guide.md"), "# Updated guide\n");
  const prose = (await run("--list")).stdout;
  expect(prose).toContain("selected: 1 of 4 test files");
  expect(prose).toContain("scripts/agent-reference-drift.test.ts");
  await writeFile(path.join(root, "src/core.ts"), "export const value = 42;\n");
  const mixed = (await run("--list")).stdout;
  expect(mixed).toContain("selected: 3 of 4 test files");
  expect(mixed).toContain("direct.test.ts");
  expect(mixed).toContain("transitive.test.ts");
  expect(mixed).not.toContain("unaffected.test.ts");
});

it("unions subprocess inputs with static consumers of the same source", async () => {
  vi.stubEnv("NO_COLOR", undefined);
  vi.stubEnv("FORCE_COLOR", "1");
  const { root, run } = await fixture();
  await mkdir(path.join(root, "test"), { recursive: true });
  await mkdir(path.join(root, ".checks"));
  await writeFile(
    path.join(root, "vitest.config.ts"),
    'export default { test: { include: ["*.test.ts", ".checks/*.test.ts"], maxWorkers: 1 } };',
  );
  await writeFile(
    path.join(root, "test/inputs.json"),
    JSON.stringify({ "**/.*/process.test.ts": ["src/**"], "**/optional.test.ts": ["src/**"] }),
  );
  await writeFile(
    path.join(root, ".checks/process.test.ts"),
    'import { execFileSync } from "node:child_process"; import { appendFileSync } from "node:fs"; import { it, expect } from "vitest"; it("process", () => { const value = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { value } from \'./src/dependant.ts\'; console.log(String(value));"], { encoding: "utf8" }); appendFileSync("executions.log", "process\\n"); expect(value).toBe("42\\n"); });',
  );
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@swizzle.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "subprocess fixture",
    ],
    { cwd: root },
  );
  await writeFile(path.join(root, "src/core.ts"), "export const value = 42;\n");
  const result = await run();
  expect(result.stdout).toContain("selected: 3 of 4 test files");
  expect(stripVTControlCharacters(result.stdout)).toContain("3 passed (3)");
  expect(
    (await readFile(path.join(root, "executions.log"), "utf8")).trim().split("\n").sort(),
  ).toEqual(["direct", "process"]);
  await writeFile(path.join(root, "test/inputs.json"), '{"missing.test.ts":["src/**"]}');
  await expect(run("--list")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("unknown test: missing.test.ts"),
  });
  await writeFile(path.join(root, "test/inputs.json"), '{"process.test.ts":"src/**"}');
  await expect(run("--list")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("must map test paths"),
  });
});

it("fails Verify when a test outside a mapped change fails", async () => {
  vi.stubEnv("MISE_TRUSTED_CONFIG_PATHS", source);
  vi.stubEnv("MISE_PARANOID", "1");
  const { root, run } = await fixture(0);
  await symlink(path.join(source, "node_modules/.bin"), path.join(root, "node_modules/.bin"));
  await mkdir(path.join(root, "scripts"));
  await symlink(
    path.join(source, "scripts/affected-tests.mts"),
    path.join(root, "scripts/affected-tests.mts"),
  );
  await writeFile(path.join(root, "justfile"), await readFile(path.join(source, "justfile")));
  await writeFile(path.join(root, "mise.toml"), await readFile(path.join(source, "mise.toml")));
  await exec("git", ["add", "."], { cwd: root });
  await exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@swizzle.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "CI fixture",
    ],
    { cwd: root },
  );
  await writeFile(path.join(root, "src/core.ts"), "export const value = 42;\n");
  // Prove that this failing file is outside the worker's affected selection.
  expect((await run("--list")).stdout).toContain("selected: 2 of 3 test files");
  const workflow = parseDocument(
    await readFile(path.join(source, ".github/workflows/ci.yml"), "utf8"),
  );
  const needs = workflow.getIn(["jobs", "verify", "needs"]);
  if (!isSeq(needs)) throw new Error("Verify must declare its prerequisites");
  const results: Record<string, { result: string }> = {};
  for (const dependency of needs.toJSON()) {
    if (typeof dependency !== "string") throw new Error("Expected a job ID");
    results[dependency] = { result: "success" };
    const rawSteps = workflow.getIn(["jobs", dependency, "steps"]);
    const steps = isAlias(rawSteps) ? rawSteps.resolve(workflow) : rawSteps;
    if (!isSeq(steps)) throw new Error(`Missing steps for ${dependency}`);
    for (const step of steps.items) {
      if (!isMap(step)) throw new Error("Expected a workflow step");
      const command = step.get("run");
      if (typeof command !== "string" || !/^just test(?:-affected)? /.test(command)) continue;
      const matrix = workflow.getIn(["jobs", dependency, "strategy", "matrix", "shard"]);
      const shards: unknown[] = isSeq(matrix) ? matrix.toJSON() : [1];
      for (const shard of shards) {
        if (typeof shard !== "number") throw new Error("Expected a numeric shard");
        const rendered = command
          .replaceAll(`\${{ matrix.shard }}`, String(shard))
          .replaceAll(`\${{ strategy.job-total }}`, String(shards.length));
        const shardEnv = workflow.getIn(["jobs", dependency, "env", "SHARD"]);
        const result = await exec("bash", ["-euo", "pipefail", "-c", rendered], {
          cwd: root,
          env: {
            ...process.env,
            MISE_TRUSTED_CONFIG_PATHS: root,
            TEST_BASE: "HEAD",
            SHARD: typeof shardEnv === "string" ? shardEnv : "",
            NODE_ENV: "test",
          },
        }).then(
          () => "success",
          (error: unknown) => {
            expect(error).toMatchObject({ code: 1, stdout: expect.stringContaining("unaffected") });
            return "failure";
          },
        );
        if (result === "failure") results[dependency] = { result };
      }
    }
  }
  const verdict = workflow.getIn(["jobs", "verify", "steps", 0, "run"]);
  if (typeof verdict !== "string") throw new Error("Expected Verify's shell verdict");
  await expect(
    exec("bash", ["-euo", "pipefail", "-c", verdict], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
    }),
  ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("failure") });
});

it("requires every CI shard to succeed independently", async () => {
  const workflow = parseDocument(
    await readFile(path.join(source, ".github/workflows/ci.yml"), "utf8"),
  );
  const jobs = workflow.get("jobs");
  const needs = workflow.getIn(["jobs", "verify", "needs"]);
  const verdict = workflow.getIn(["jobs", "verify", "steps", 0, "run"]);
  if (!isMap(jobs) || !isSeq(needs) || typeof verdict !== "string")
    throw new Error("Expected jobs and Verify's dependencies and verdict");
  const results: Record<string, { result: string }> = {};
  for (const dependency of needs.toJSON()) {
    if (typeof dependency !== "string") throw new Error("Expected a job ID");
    results[dependency] = { result: "success" };
  }
  const runVerdict = () =>
    exec("bash", ["-euo", "pipefail", "-c", verdict], {
      env: { ...process.env, RESULTS: JSON.stringify(results) },
    });
  expect((await runVerdict()).stdout).toContain("test-1: success");
  const shards: string[] = [];
  for (const { key, value } of jobs.items) {
    if (!isMap(value)) continue;
    const env = value.get("env");
    if (!isMap(env) || !env.has("SHARD")) continue;
    if (!isScalar(key) || typeof key.value !== "string") throw new Error("Expected a shard job ID");
    const id = key.value;
    shards.push(id);
    expect(results[id]).toEqual({ result: "success" });
    expect(value.has("strategy")).toBe(false);
    for (const result of ["failure", "cancelled", "skipped"]) {
      results[id] = { result };
      await expect(runVerdict()).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining(`${id}: ${result}`),
      });
    }
    results[id] = { result: "success" };
  }
  expect(shards).toHaveLength(3);
});

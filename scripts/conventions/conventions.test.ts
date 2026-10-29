import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../../test/support.js";
import { lint } from "./lint.js";
import { gitRepo, readRepo } from "./repo.js";
import { SKILL, SKILL_REQUIRES } from "./rules/skill-teaches-the-product.js";
import { rules } from "./rules.js";

/** Plants `files` in a fresh directory and returns where one rule reports them, as sorted `file:line`. */
async function reported(ruleId: string, files: Record<string, string>): Promise<string[]> {
  const rule = rules.find((candidate) => candidate.id === ruleId);
  if (rule === undefined) throw new Error(`rules.ts lists no rule ${ruleId}`);
  const root = await temporaryDirectory("swizzle-conventions-");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return lint(readRepo(root, Object.keys(files)), [rule])
    .map(({ file, line }) => `${file}:${line}`)
    .toSorted();
}

const recipes = "# Install everything.\nsetup:\n    true\n\n# Lint and types.\ncheck:\n    true\n";

it("platform-version names every release copy that disagrees with the root version", async () => {
  const tree = {
    "package.json": '{ "version": "2.0.0" }',
    "apps/cli/package.json": '{ "version": "2.0.0" }',
    "packages/db/package.json": '{ "version": "2.0.0" }',
    "packages/core/src/version.ts": 'export const APP_VERSION = "2.0.0";',
    "infra/examples/demo/package.json": '{ "version": "0.1.0" }',
  };
  expect(await reported("platform-version", tree)).toEqual([]);
  for (const [file, text] of Object.entries(tree).filter(([file]) => !file.startsWith("infra/"))) {
    const changed = {
      ...tree,
      [file]: text.replaceAll("2.0.0", "3.0.0"),
    };
    expect(await reported("platform-version", changed)).toEqual(
      file === "package.json"
        ? [
            "apps/cli/package.json:1",
            "packages/core/src/version.ts:1",
            "packages/db/package.json:1",
          ]
        : [`${file}:1`],
    );
  }
  expect(
    await reported("platform-version", {
      ...tree,
      "apps/cli/package.json": "{}",
    }),
  ).toEqual(["apps/cli/package.json:1"]);
});

it("no-env-example-copy reports cp .env.example in docs and scripts", async () => {
  expect(
    await reported("no-env-example-copy", {
      "docs/install.md": "Run `just setup`.\n",
      "scripts/x.sh": "cp .env.template .env.example\n",
    }),
  ).toEqual([]);
  expect(
    await reported("no-env-example-copy", {
      "docs/install.md": "Run `cp .env.example .env`.\n",
      "scripts/x.sh": 'set -e\ncp "$ROOT/.env.example" .env\n',
    }),
  ).toEqual(["docs/install.md:1", "scripts/x.sh:2"]);
});

it("env-example-reaches-compose reports a setting the packaged stack never reads", async () => {
  const compose = `services:\n  api:\n    environment:\n      SWIZZLE_A: \${SWIZZLE_A:-1}\n      SWIZZLE_B: \${SWIZZLE_B}\n`;

  expect(
    await reported("env-example-reaches-compose", {
      ".env.example": "SWIZZLE_A=1\n# SWIZZLE_B=2\n# Example:\n#   SWIZZLE_C=3\n",
      "infra/docker/compose.yml": compose,
    }),
  ).toEqual([]);
  expect(
    await reported("env-example-reaches-compose", {
      ".env.example": "SWIZZLE_A=1\n# SWIZZLE_D=on\n",
      "infra/docker/compose.yml": compose,
    }),
  ).toEqual([".env.example:2"]);
  expect(
    await reported("env-example-reaches-compose", {
      ".env.example": "SWIZZLE_A=1\n# SWIZZLE_D=on\n",
      "infra/docker/compose.yml": `${compose}  worker:\n    extends: { file: execution.yml, service: worker }\n`,
      "infra/docker/execution.yml": `services:\n  worker:\n    environment:\n      D: \${SWIZZLE_D:-off}\n`,
    }),
  ).toEqual([]);
});

it("an allow with a reason silences its rule on the next line; one without a reason does not", async () => {
  const copy = "Run `cp .env.example .env`.\n";

  expect(
    await reported("no-env-example-copy", {
      "docs/install.md": `<!-- conventions-allow no-env-example-copy: the fixture needs it -->\n${copy}`,
    }),
  ).toEqual([]);
  expect(
    await reported("no-env-example-copy", {
      "docs/install.md": `<!-- conventions-allow no-env-example-copy: -->\n${copy}`,
    }),
  ).toEqual(["docs/install.md:2"]);
});

it("docs-run-just-recipes reports direct tool runs and unknown recipes in Markdown code", async () => {
  expect(
    await reported("docs-run-just-recipes", {
      justfile: recipes,
      "docs/operations.md":
        "```sh\n$ just setup\n```\n\n```ts\npnpm.install();\n```\n\nThen `just check`, which loads scripts with `tsx`.\n",
      "docs/author.md":
        "```bash\nnpm install --global @swizzletech/cli\nnpm install --global left-pad\n```\n",
    }),
  ).toEqual(["docs/author.md:3"]);
  expect(
    await reported("docs-run-just-recipes", {
      justfile: recipes,
      "docs/operations.md":
        "Then `pnpm test` and `just lint`.\n\n```bash\njust setup \\\n  && vitest run\n```\n",
    }),
  ).toEqual(["docs/operations.md:1", "docs/operations.md:1", "docs/operations.md:5"]);
});

it("lints the tracked and staged files of a checkout and skips untracked ones", async () => {
  const root = await temporaryDirectory("swizzle-conventions-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "--quiet");
  await writeFile(path.join(root, "justfile"), recipes);
  await writeFile(path.join(root, "staged.md"), "Run `pnpm test`.\n");
  await writeFile(path.join(root, "NOTES.md"), "Ran `pnpm test`.\n");
  git("add", "justfile", "staged.md");
  const rule = rules.filter((candidate) => candidate.id === "docs-run-just-recipes");

  expect(lint(gitRepo(root), rule).map(({ file, line }) => `${file}:${line}`)).toEqual([
    "staged.md:1",
  ]);
});

it("docs-run-just-recipes locates a code block in a list item after prose with the same text", async () => {
  // The hatch on line 4 covers the command on line 5 only if the block is placed on line 3.
  expect(
    await reported("docs-run-just-recipes", {
      justfile: recipes,
      "docs/list.md":
        "- Run pnpm install:\n\n      pnpm install\n      # conventions-allow docs-run-just-recipes: shows the raw tool\n      pnpm install\n",
    }),
  ).toEqual(["docs/list.md:3"]);
});

it("docs-run-just-recipes reads a span after a tilde fence that holds a backtick fence", async () => {
  expect(
    await reported("docs-run-just-recipes", {
      justfile: recipes,
      "docs/fenced.md": "# Guide\n\n~~~md\n```\n~~~\n\nThen run `pnpm install` directly.\n",
    }),
  ).toEqual(["docs/fenced.md:7"]);
});

it("tests-wait-on-state reports a test that waits on time, sets its own budget or retries", async () => {
  const lines = (...code: string[]) => `${code.join("\n")}\n`;
  expect(
    await reported("tests-wait-on-state", {
      "apps/web/tests/flow.spec.ts": lines(
        'import { expect, test } from "@playwright/test";',
        'test("flow", async ({ page }) => {',
        "  test.setTimeout(180_000);",
        "  await page.waitForTimeout(2_000);",
        '  await page.getByRole("link").click({ timeout: 2_000 });',
        "  await new Promise((resolve) => setTimeout(resolve, 8_000));",
        "});",
        "test.describe.configure({ retries: 2 });",
      ),
      "packages/core/src/a.test.ts": lines(
        'import { setTimeout as pause } from "node:timers/promises";',
        'import { setImmediate } from "node:timers/promises";',
        'it("a", async () => {',
        "  await pause(50);",
        "  const started = performance.now();",
        "  expect(performance.now() - started).toBeLessThan(60_000);",
        "  await vi.waitFor(() => ready);",
        "  await expect.poll(() => ready).toBe(true);",
        "  while (!ready) await setImmediate();",
        "}, 10_000);",
        'describe("b", { timeout: 60_000 }, () => {});',
        "beforeAll(async () => {}, 20_000);",
      ),
      "test/helpers.ts": lines("export const tick = () => globalThis.setInterval(() => {}, 1);"),
      "playwright.config.ts": lines("export default { timeout: 45_000, retries: 0 };"),
    }),
  ).toEqual([
    "apps/web/tests/flow.spec.ts:3",
    "apps/web/tests/flow.spec.ts:4",
    "apps/web/tests/flow.spec.ts:5",
    "apps/web/tests/flow.spec.ts:6",
    "apps/web/tests/flow.spec.ts:8",
    "packages/core/src/a.test.ts:10",
    "packages/core/src/a.test.ts:11",
    "packages/core/src/a.test.ts:12",
    "packages/core/src/a.test.ts:4",
    "packages/core/src/a.test.ts:6",
    "packages/core/src/a.test.ts:7",
    "packages/core/src/a.test.ts:8",
    "packages/core/src/a.test.ts:9",
    "playwright.config.ts:1",
    "test/helpers.ts:1",
  ]);
  // A wait in the code a test writes for a child, a dated fixture, a web-first poll, the
  // runners' own ceilings, code outside the tests and a reasoned allow stay.
  expect(
    await reported("tests-wait-on-state", {
      "apps/web/tests/flow.spec.ts": lines(
        'import { expect, test } from "@playwright/test";',
        'test("flow", async ({ page }) => {',
        "  await expect.poll(() => sent.length).toBe(2);",
        "  await expect(page.getByRole('heading')).toBeVisible();",
        "});",
      ),
      "packages/core/src/a.test.ts": lines(
        'it("a", async ({ signal }) => {',
        '  const child = "setTimeout(() => process.exit(0), 300)";',
        "  const old = new Date(Date.now() - 11 * 60_000);",
        "  await waitFor(signal, () => ready);",
        "  // conventions-allow tests-wait-on-state: the lease under test expires on the wall clock.",
        "  setInterval(renew, 2_000);",
        "});",
      ),
      "packages/core/src/a.ts": lines("await new Promise((resolve) => setTimeout(resolve, 10));"),
      "playwright.config.ts": lines(
        "export default { timeout: 45_000, expect: { timeout: 15_000 } };",
      ),
      "vitest.config.ts": lines("export default { test: { testTimeout: 30_000 } };"),
    }),
  ).toEqual([]);
});

it("tests-wait-on-state reports the deadlines and durations a loaded runner fails", async () => {
  const lines = (...code: string[]) => `${code.join("\n")}\n`;
  expect(
    await reported("tests-wait-on-state", {
      "apps/web/tests/flow.spec.ts": lines(
        'import { expect, test } from "@playwright/test";',
        "test.use({ actionTimeout: 1_000, expect: { timeout } });",
        'test("flow", async ({ page }) => {',
        "  page.setDefaultTimeout(5_000);",
        '  await expect(page.getByText("Saved")).toBeVisible({ timeout: SHORT });',
        "});",
      ),
      "packages/core/src/a.test.ts": lines(
        'it("a", async () => {',
        "  await fetch(url, { signal: AbortSignal.timeout(2_000) });",
        "  expect(result.durationMs).toBeLessThan(500);",
        "  expect(process.hrtime(start)[0]).toBe(0);",
        "  const opened = new Date();",
        "  expect(new Date().getTime() - opened.getTime()).toBe(0);",
        "});",
      ),
      "packages/core/src/b.test.ts": lines(
        'import * as timers from "node:timers/promises";',
        'import nodeTimers from "node:timers";',
        'it("b", async () => {',
        "  await timers.setTimeout(100);",
        "  nodeTimers.setInterval(poll, 50);",
        "}, TIMEOUT);",
        'it("c", () => {}, budget());',
        "beforeAll(() => {}, timeoutMs);",
      ),
      "packages/core/test/helpers.ts": lines("export const pause = () => setTimeout(() => {}, 5);"),
    }),
  ).toEqual([
    "apps/web/tests/flow.spec.ts:2",
    "apps/web/tests/flow.spec.ts:2",
    "apps/web/tests/flow.spec.ts:4",
    "apps/web/tests/flow.spec.ts:5",
    "packages/core/src/a.test.ts:2",
    "packages/core/src/a.test.ts:3",
    "packages/core/src/a.test.ts:4",
    "packages/core/src/a.test.ts:6",
    "packages/core/src/b.test.ts:4",
    "packages/core/src/b.test.ts:5",
    "packages/core/src/b.test.ts:6",
    "packages/core/src/b.test.ts:7",
    "packages/core/src/b.test.ts:8",
    "packages/core/test/helpers.ts:1",
  ]);
  // Data the test expects under a timeout key, an upper bound on anything but a duration, a
  // duration in words, a fixture dated from one clock reading, a duration of a clock the test sets,
  // and the options and body overloads of a test stay.
  expect(
    await reported("tests-wait-on-state", {
      "packages/core/src/a.test.ts": lines(
        'it("a", () => {',
        '  expect(config).toMatchObject({ timeout: "60s", retry: { max_attempts: 3 } });',
        "  expect(response.statusCode).toBeLessThan(300);",
        '  expect(durationInWords(5_400_000)).toBe("1 h 30 min");',
        "  const old = new Date(new Date().getTime() - 60_000);",
        "});",
      ),
      "packages/core/src/clock.test.ts": lines(
        'it("a", () => {',
        "  vi.useFakeTimers({ now: 0 });",
        "  const start = Date.now();",
        "  vi.setSystemTime(100);",
        "  expect(Date.now() - start).toBe(100);",
        "});",
      ),
      "apps/web/tests/flow.spec.ts": lines(
        'import { expect, test } from "@playwright/test";',
        'test("a", { tag: "@slow" }, async ({ page }) => {',
        '  await test.step("open", async () => {}, { box: true });',
        "});",
        'test.describe("b", () => {});',
      ),
    }),
  ).toEqual([]);
});

it("no-coverage-gate reports a coverage threshold in test configuration", async () => {
  expect(
    await reported("no-coverage-gate", {
      "vitest.config.ts": "export default { test: { coverage: { provider: 'v8' } } };\n",
    }),
  ).toEqual([]);
  expect(
    await reported("no-coverage-gate", {
      "vitest.config.ts": "export default { test: { coverage: { thresholds: { lines: 80 } } } };\n",
    }),
  ).toEqual(["vitest.config.ts:1"]);
});

it("skill-teaches-the-product reports a wrong claim and a dropped correction in the shipped skill", async () => {
  const operations = `The worker ${SKILL_REQUIRES[1]}; ${SKILL_REQUIRES[2]}.\n`;

  expect(
    await reported("skill-teaches-the-product", {
      [`${SKILL}/SKILL.md`]: `Ship with \`${SKILL_REQUIRES[0]}\`.\n`,
      [`${SKILL}/references/operations.md`]: operations,
    }),
  ).toEqual([]);
  expect(
    await reported("skill-teaches-the-product", {
      [`${SKILL}/SKILL.md`]: "Build from Dockerfile.service.\n",
      [`${SKILL}/references/operations.md`]: operations,
    }),
  ).toEqual([`${SKILL}/SKILL.md:1`, `${SKILL}/SKILL.md:1`]);
});

it("skill-teaches-the-product rejects home mounts and inferred webhook paths", async () => {
  const required = SKILL_REQUIRES.join("\n");
  const file = `${SKILL}/references/config-reference.md`;
  expect(
    await reported("skill-teaches-the-product", {
      [`${SKILL}/SKILL.md`]: required,
      [file]: [
        "      - ~/data",
        "Declare paths (typically under `~/`) where the CLI can write.",
        "path: /my-path # optional; auto-derived from name if omitted",
        "If `path` is omitted, one is derived from `name`.",
      ].join("\n"),
    }),
  ).toEqual([`${file}:1`, `${file}:2`, `${file}:3`, `${file}:4`]);
  expect(
    await reported("skill-teaches-the-product", {
      [`${SKILL}/SKILL.md`]: required,
      [file]:
        "writable_dirs: [./work, /tmp/tool-cache]\nWebhook deployment requires trigger.path.\n",
    }),
  ).toEqual([]);
});

it("skill-teaches-the-product reports a repository path that an author's laptop does not have", async () => {
  const required = SKILL_REQUIRES.join("\n");
  const file = `${SKILL}/references/sdk.md`;
  expect(
    await reported("skill-teaches-the-product", {
      [`${SKILL}/SKILL.md`]: required,
      "infra/docker/Dockerfile": "FROM debian\n",
      "infra/examples/hello/config.yaml": "name: hello\n",
      "docs/reference/config.md": "# Config\n",
      [file]: [
        "Check `infra/docker/Dockerfile` first.",
        "Start from `infra/examples/`.",
        "See [the reference](../../../../../../docs/reference/config.md).",
        "Read [the Dockerfile](https://github.com/swizzletech/swizzle/blob/main/infra/docker/Dockerfile).",
        "Write under `automations/hello` and read [SDK Usage](../SKILL.md#sdk).",
        "Start from `infra/`.",
      ].join("\n"),
    }),
  ).toEqual([`${file}:1`, `${file}:2`, `${file}:3`, `${file}:6`]);
});

it("skill-names-the-runner-image reports a runner-base package or Node major the skill does not name", async () => {
  const tree = {
    "infra/docker/Dockerfile": [
      "FROM node:26.12.1-trixie-slim AS runner-base",
      "RUN apt-get update \\",
      "  && apt-get install -y --no-install-recommends git \\",
      "    poppler-utils \\",
      "  && rm -rf /var/lib/apt/lists/*",
      "RUN npm install --global --no-audit --no-fund \\",
      "  @openai/codex@0.163.0",
      "FROM base AS deps",
      "RUN npm install --global pnpm@12.15.0",
      "",
    ].join("\n"),
    [`${SKILL}/SKILL.md`]:
      "- Node.js 26 with npm\n\nThe exact packages: Debian `git`, `poppler-utils`; npm `@openai/codex`.\n",
  };
  expect(await reported("skill-names-the-runner-image", tree)).toEqual([]);
  expect(
    await reported("skill-names-the-runner-image", {
      ...tree,
      "infra/docker/Dockerfile": tree["infra/docker/Dockerfile"]
        .replace("26.12.1", "28.0.0")
        .replace("poppler-utils", "poppler-utils ffmpeg"),
    }),
  ).toEqual([`${SKILL}/SKILL.md:1`, `${SKILL}/SKILL.md:3`]);
  // runner-base as the last stage, with the install on one line.
  const [last = ""] = tree["infra/docker/Dockerfile"].split("FROM base AS deps");
  expect(
    await reported("skill-names-the-runner-image", {
      ...tree,
      "infra/docker/Dockerfile": last.replace("git \\\n    poppler-utils", "git poppler-utils"),
    }),
  ).toEqual([]);
});

it("ci-runs-just-recipes reports workflow and action commands that are not just recipes", async () => {
  expect(
    await reported("ci-runs-just-recipes", {
      ".github/workflows/ci.yml": [
        "jobs:",
        "  v:",
        "    steps:",
        "      - run: just verify",
        '      - run: just test "a|b"',
        "      - run: |",
        "          # setup; then smoke",
        "          just setup && just smoke # both",
        "",
      ].join("\n"),
    }),
  ).toEqual([]);
  expect(
    await reported("ci-runs-just-recipes", {
      ".github/workflows/ci.yml": [
        "jobs:",
        "  v:",
        "    steps:",
        "      - run: just check && pnpm test",
        "      - run: 'pnpm test'",
        "      - run: |",
        "          just setup",
        "          pnpm test",
        "",
      ].join("\n"),
      ".github/actions/toolchain/action.yml": "runs:\n  steps:\n    - run: npm ci\n",
    }),
  ).toEqual([
    ".github/actions/toolchain/action.yml:3",
    ".github/workflows/ci.yml:4",
    ".github/workflows/ci.yml:5",
    ".github/workflows/ci.yml:8",
  ]);
});

it("ci-runs-just-recipes reports a command on its own line inside a folded or quoted script", async () => {
  expect(
    await reported("ci-runs-just-recipes", {
      ".github/workflows/ci.yml": [
        "jobs:",
        "  v:",
        "    steps:",
        "      - run: > # conventions-allow ci-runs-just-recipes: covers this line and the next",
        "          just setup &&",
        "          pnpm test",
        '      - run: "just setup &&',
        '          pnpm test"',
        "",
      ].join("\n"),
    }),
  ).toEqual([".github/workflows/ci.yml:6", ".github/workflows/ci.yml:8"]);
});

it("no-root-package-scripts reports scripts in the root package.json", async () => {
  expect(
    await reported("no-root-package-scripts", { "package.json": '{ "name": "a" }\n' }),
  ).toEqual([]);
  expect(
    await reported("no-root-package-scripts", {
      "package.json": '{\n  "name": "a",\n  "scripts": { "test": "vitest" }\n}\n',
    }),
  ).toEqual(["package.json:3"]);
});

it("lockfile-frozen reports a pnpm install that may rewrite the lockfile", async () => {
  expect(
    await reported("lockfile-frozen", {
      justfile: "# Install.\nsetup:\n    pnpm install --frozen-lockfile\n",
      "infra/docker/Dockerfile":
        "FROM node:22\nRUN --mount=type=cache,target=/s pnpm install \\\n    --frozen-lockfile --offline\n",
      "infra/docker/Dockerfile.exec":
        'FROM node:22\nRUN ["pnpm", "install", "--frozen-lockfile"]\n',
      "scripts/install.sh": "pnpm --filter db install --frozen-lockfile\n",
    }),
  ).toEqual([]);
  expect(
    await reported("lockfile-frozen", {
      justfile:
        "# Install.\nsetup:\n    @{{ just_executable() }} --version\n    pnpm install --frozen-lockfile=false\n",
      "infra/docker/Dockerfile": "FROM node:22\nRUN corepack enable && pnpm install --offline\n",
      "infra/docker/Dockerfile.exec":
        'FROM node:22\nrun pnpm install --offline\nRUN ["pnpm", "install", "--offline"]\n',
      "scripts/install.sh":
        "pnpm install --frozen-lockfile \\\n  --no-frozen-lockfile\npnpm --dir packages/db install\n",
      ".github/workflows/ci.yml": "jobs:\n  v:\n    steps:\n      - run: pnpm i\n",
    }),
  ).toEqual([
    ".github/workflows/ci.yml:4",
    "infra/docker/Dockerfile.exec:2",
    "infra/docker/Dockerfile.exec:3",
    "infra/docker/Dockerfile:2",
    "justfile:4",
    "scripts/install.sh:1",
    "scripts/install.sh:3",
  ]);
});

it("recipes-say-why reports a public recipe without a one-line doc comment", async () => {
  expect(
    await reported("recipes-say-why", { justfile: `_hidden:\n    true\n\n${recipes}` }),
  ).toEqual([]);
  expect(await reported("recipes-say-why", { justfile: `${recipes}\nlint:\n    true\n` })).toEqual([
    "justfile:9",
  ]);
  expect(
    await reported("recipes-say-why", {
      justfile: `${recipes}\n# Restore the bundle.\n# It runs as the image's user.\n[confirm]\nrestore:\n    true\n`,
    }),
  ).toEqual(["justfile:10"]);
});

it("locates the selected OS recipe when its header follows another variant", async () => {
  let current: string = process.platform;
  if (current === "darwin") current = "macos";
  else if (current === "win32") current = "windows";
  const other = current === "linux" ? "macos" : "linux";
  expect(
    await reported("lockfile-frozen", {
      justfile: `[${other}]\ne2e:\n    pnpm install --frozen-lockfile\n\n[${current}]\ne2e:\n    pnpm install\n`,
    }),
  ).toEqual(["justfile:7"]);
});

it("toolchain-pins keeps mise, pnpm and every Node image aligned, including missing pins", async () => {
  const tree = {
    "mise.toml": 'node = "22.23.4"\npnpm = "12.15.0"\n',
    "package.json": '{"packageManager": "pnpm@12.15.0"}',
    "infra/docker/Dockerfile":
      "ARG NODE_VERSION=22.23.4-alpine\nFROM node:22.23.4-alpine AS runner-base\nRUN npm install --global --no-audit --no-fund pnpm@12.15.0\n",
    "packages/runtime/src/run-image.ts":
      'const RUN_TAG = 1;\nconst NODE_BASE_IMAGE = "node:22.23.4-slim";\n',
  };
  expect(await reported("toolchain-pins", tree)).toEqual([]);
  expect(
    await reported("toolchain-pins", {
      ...tree,
      "package.json": '{"packageManager": "pnpm@11.0.0"}',
      "infra/docker/Dockerfile": tree["infra/docker/Dockerfile"]
        .replaceAll("22.23.4", "20.0.0")
        .replace("12.15.0", "11.0.0"),
      "packages/runtime/src/run-image.ts": tree["packages/runtime/src/run-image.ts"].replace(
        "22.23.4",
        "20.0.0",
      ),
    }),
  ).toEqual([
    "infra/docker/Dockerfile:1",
    "infra/docker/Dockerfile:2",
    "infra/docker/Dockerfile:3",
    "package.json:1",
    "packages/runtime/src/run-image.ts:2",
  ]);
  expect(await reported("toolchain-pins", { ...tree, "package.json": "{}" })).toEqual([
    "package.json:1",
  ]);
});

it("doc-links resolves files, directories, linked symbols and images while skipping Markdown code", async () => {
  const tree = {
    "src/main.ts":
      "export function createProgram() {}\nconst createProgramSuffix = 1;\nconst $value = 2;",
    "diagram.png": "image",
    "GUIDE.md": [
      "[`createProgram`](src/main.ts) [`$value`](src/main.ts)",
      "~~~",
      "[tilde](tilde.md)",
      "~~~",
      "  ```bash",
      "  [indented](indented.md)",
      "  ```",
      "````md",
      "```",
      "[nested](nested.md)",
      "```",
      "````",
      "`[span](span.md)` [after](src/main.ts#symbol)",
      "![`ignoredAltText`](diagram.png) [dir](src/)",
      "[web](https://example.com) [anchor](#heading)",
    ].join("\n"),
  };
  expect(await reported("doc-links", tree)).toEqual([]);
  expect(
    await reported("doc-links", {
      ...tree,
      "GUIDE.md":
        "# Guide\n[missing](missing.md)\n[`createProgram`](src/main.ts)\n![image](gone.png)",
      "src/main.ts": "const createProgramSuffix = 1;",
    }),
  ).toEqual(["GUIDE.md:2", "GUIDE.md:3", "GUIDE.md:4"]);
});

it("doc-links requires the docs index to cover pages, excluding its own page and ADRs", async () => {
  const tree = {
    "docs/README.md": "[guide](how-to/guide.md#heading)",
    "docs/how-to/guide.md": "[source](../../src/main.ts)",
    "docs/adr/0001.md": "Decision",
    "src/main.ts": "source",
  };
  expect(await reported("doc-links", tree)).toEqual([]);
  expect(await reported("doc-links", { ...tree, "docs/how-to/other.md": "Unindexed" })).toEqual([
    "docs/how-to/other.md:1",
  ]);
});

it("doc-links accepts links to the repository root from nested and root Markdown", async () => {
  const tree = {
    "docs/README.md": "[root](../)",
    "GUIDE.md": "[root](./)",
  };
  expect(await reported("doc-links", tree)).toEqual([]);
  expect(await reported("doc-links", { ...tree, "GUIDE.md": "[missing](missing/)" })).toEqual([
    "GUIDE.md:1",
  ]);
});

it("sdk-copies-match reports a vendored SDK copy at its first line that differs from the package", async () => {
  const tree = {
    "packages/sdk-ts/src/index.ts": "export const a = 1;\nexport const b = 2;\n",
    "packages/sdk-py/swizzle_sdk.py": "A = 1\n",
    "infra/examples/hook/swizzle-sdk.ts": "export const a = 1;\nexport const b = 2;\n",
    "infra/examples/scan/swizzle_sdk.py": "A = 1\n",
  };
  expect(await reported("sdk-copies-match", tree)).toEqual([]);
  expect(
    await reported("sdk-copies-match", {
      ...tree,
      "infra/examples/hook/swizzle-sdk.ts": "export const a = 1;\n",
      "infra/examples/scan/swizzle_sdk.py": "A = 0\n",
    }),
  ).toEqual(["infra/examples/hook/swizzle-sdk.ts:2", "infra/examples/scan/swizzle_sdk.py:1"]);
});

it("no-other-products reports a product name in any tracked file but a lockfile", async () => {
  expect(
    await reported("no-other-products", {
      "docs/a.md":
        // conventions-allow no-other-products: the rule's own test plants the names
        "Like Zapier, but code.\nA temporal order of steps.\nA temporal workflow like Zapier.\n",
      // conventions-allow no-other-products: the rule's own test plants the names
      "apps/cli/src/b.ts": "// senders such as n8n\nconst Temporal = 1;\n",
      // conventions-allow no-other-products: the rule's own test plants the names
      "pnpm-lock.yaml": "supabase: 1.0.0\n",
      [`${SKILL}/references/config-reference.md`]:
        // conventions-allow no-other-products: the rule's own test plants the names
        "Equivalent to Kubernetes CronJob `concurrencyPolicy: Forbid`.\nA directed graph of steps.\nLike an Airflow DAG.\n",
    }),
  ).toEqual([
    `${SKILL}/references/config-reference.md:1`,
    `${SKILL}/references/config-reference.md:3`,
    "apps/cli/src/b.ts:1",
    "apps/cli/src/b.ts:2",
    "docs/a.md:1",
    "docs/a.md:3",
  ]);
});

it("review-config-paths reports a pattern or named file in the review configuration that matches nothing", async () => {
  const config = [
    "reviews:",
    "  path_filters:",
    '    - "!pnpm-lock.yaml"',
    '    - "!docs/generated/**"',
    "  path_instructions:",
    '    - path: "apps/**/*.ts"',
    "      instructions: >-",
    "        Follow `docs/rules.md` and `docs/moved.md`. Keep data in `packages/db` and",
    "        `packages/gone`; call `vi.stubEnv` and `just gen`.",
    "knowledge_base:",
    "  code_guidelines:",
    "    filePatterns:",
    '      - files: "docs/rules.md,docs/renamed.md"',
    '        applyTo: "packages/**,web/**,{apps,packages}/**/*.ts"',
    "",
  ].join("\n");
  expect(
    await reported("review-config-paths", {
      ".coderabbit.yaml": config,
      "pnpm-lock.yaml": "",
      "apps/api/main.ts": "",
      "packages/db/schema.ts": "",
      "docs/rules.md": "",
    }),
  ).toEqual([
    ".coderabbit.yaml:13",
    ".coderabbit.yaml:14",
    ".coderabbit.yaml:4",
    ".coderabbit.yaml:8",
    ".coderabbit.yaml:9",
  ]);
});

it("no-private-paths reports a public file that names a file the export leaves out", async () => {
  const login = ".agents/skills/demo/scripts/login";
  expect(
    await reported("no-private-paths", {
      [login]: "#!/bin/sh\n",
      "docs/adr/0001-demo.md": "Decision\n",
      "scripts/login.test.ts": `import path from "node:path";\nconst login = path.resolve("${login}");\n`,
      "docs/guide.md":
        "See [the decision](adr/0001-demo.md).\n`workspace init` writes AGENTS.md and `.agents/skills/` in a workspace.\n",
      ".agents/checks/login.test.ts": `const login = path.resolve("${login}");\n`,
    }),
  ).toEqual(["docs/guide.md:1", "scripts/login.test.ts:2"]);
});

it("no-private-paths inspects the configuration that ships, including retained text", async () => {
  const hidden = "nested/.agents/tool.ts";
  const files = {
    [hidden]: "private checks",
    "test/inputs.json": JSON.stringify({
      [hidden]: [hidden],
      "public.test.ts": [hidden, "scripts/**"],
    }),
    "tsconfig.test.json": JSON.stringify({ include: [hidden, "scripts/**"] }),
  };
  expect(await reported("no-private-paths", files)).toEqual([]);
  expect(
    await reported("no-private-paths", {
      ...files,
      "tsconfig.test.json": JSON.stringify({
        description: hidden,
        include: [hidden, "scripts/**"],
      }),
    }),
  ).toEqual(["tsconfig.test.json:1"]);
});

it("web-reads-the-contract reports a dashboard call whose answer is not a contract type", async () => {
  const imports = [
    'import { request } from "./request.js";',
    'import type { RunsResponse, HealthResponse, TokenResponse, IdentityResponse } from "../api.js";',
  ].join("\n");
  const tree = {
    "packages/db/src/index.ts":
      "export interface TokenView { readonly id: string }\nexport interface IdentityResponse { readonly user: string }",
    "apps/web/src/lib/api.ts":
      'export type * from "../../../../packages/runtime/src/http-contract.js";',
    "packages/runtime/src/http-contract.ts": [
      "export type RunsResponse = readonly Run[];",
      "export interface HealthResponse { readonly ok: boolean }",
      "export type {",
      "  TokenView as TokenResponse,",
      "  IdentityResponse,",
      '} from "../../db/src/index.js";',
    ].join("\n"),
    "apps/web/src/lib/api/request.ts":
      "export async function request<T>(path: string): Promise<T> {}\n",
    "apps/web/src/lib/api/runs.ts": [
      imports,
      "await request<RunsResponse>(`/runs`);",
      "await request<HealthResponse>(`/health`, {});",
      "await request<",
      "  TokenResponse",
      ">(`/tokens/1`);",
      "await request<IdentityResponse>(`/me`);",
      "await request<unknown>(`/auth/sign-out`);",
    ].join("\n"),
  };
  expect(await reported("web-reads-the-contract", tree)).toEqual([]);
  expect(
    await reported("web-reads-the-contract", {
      ...tree,
      "apps/web/src/lib/api/runs.ts": [
        imports,
        "await request<RunsResponse>(`/runs`);",
        "await request<{ readonly runs: Run[]; readonly next: () => void }>(`/runs`);",
        "await request<RunsResponse[number]>(`/runs/1`);",
        "await request<TokenView>(`/tokens/1`);",
        "const runs: Run[] = await request(`/runs`);",
      ].join("\n"),
    }),
  ).toEqual([
    "apps/web/src/lib/api/runs.ts:4",
    "apps/web/src/lib/api/runs.ts:5",
    "apps/web/src/lib/api/runs.ts:6",
    "apps/web/src/lib/api/runs.ts:7",
  ]);
});

it("web-reads-the-contract resolves request and response bindings and ignores non-code examples", async () => {
  expect(
    await reported("web-reads-the-contract", {
      "packages/runtime/package.json": JSON.stringify({
        name: "@swizzle/runtime",
        exports: { "./http-contract": { "swizzle-source": "./src/http-contract.ts" } },
      }),
      "packages/db/package.json": JSON.stringify({
        name: "@swizzle/db",
        exports: { ".": { "swizzle-source": "./src/index.ts" } },
      }),
      "packages/db/src/index.ts": "export interface TokenView { readonly id: string }",
      "packages/runtime/src/http-contract.ts": [
        "interface Runs { readonly runs: string[] }",
        "export type { Runs as RunsResponse };",
        'export type { TokenView as TokenResponse } from "@swizzle/db";',
      ].join("\n"),
      "apps/web/src/lib/api.ts": 'export type * from "@swizzle/runtime/http-contract";',
      "apps/web/src/lib/api/request.ts":
        "export declare function request<T>(path: string): Promise<T>;",
      "apps/web/src/lib/other.ts": "export interface RunsResponse { readonly other: boolean }",
      "apps/web/src/lib/api/runs.ts": [
        'import { request, request as read } from "./request";',
        'import * as transport from "./request.js";',
        'import type { RunsResponse as Reply, TokenResponse } from "../api";',
        'import type { RunsResponse, RunsResponse as OtherReply } from "../other.js";',
        'await read<Reply>("/runs");',
        'await read<TokenResponse>("/tokens/1");',
        'await request<RunsResponse>("/runs");',
        'await read<{ readonly runs: string[] }>("/runs");',
        'await read("/runs");',
        'await transport.request<RunsResponse>("/runs");',
        "type Copy = Reply;",
        'await read<Copy>("/runs");',
        "function local() {",
        "  interface RunsResponse { readonly runs: string[] }",
        '  return request<RunsResponse>("/runs");',
        "}",
        'function shadow<Reply>() { return read<Reply>("/runs"); }',
        'await read<Reply | unknown>("/runs");',
        'await read<Reply[]>("/runs");',
        'await read<Reply<string>>("/runs");',
        'await read<unknown>("/ignored");',
        '// request<{ readonly example: boolean }>("/example");',
        '/* request<Missing>("/example"); */',
        "const example = 'request<Missing>(\"/example\")';",
        'const template = `request<Missing>("/example")`;',
        "function unrelated(request: <T>(path: string) => T) {",
        '  return request<{ readonly unrelated: true }>("/elsewhere");',
        "}",
        'await read<OtherReply>("/runs");',
      ].join("\n"),
    }),
  ).toEqual([
    "apps/web/src/lib/api/runs.ts:10",
    "apps/web/src/lib/api/runs.ts:12",
    "apps/web/src/lib/api/runs.ts:15",
    "apps/web/src/lib/api/runs.ts:17",
    "apps/web/src/lib/api/runs.ts:18",
    "apps/web/src/lib/api/runs.ts:19",
    "apps/web/src/lib/api/runs.ts:20",
    "apps/web/src/lib/api/runs.ts:29",
    "apps/web/src/lib/api/runs.ts:7",
    "apps/web/src/lib/api/runs.ts:8",
    "apps/web/src/lib/api/runs.ts:9",
  ]);
});

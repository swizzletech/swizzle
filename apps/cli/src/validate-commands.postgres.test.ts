import { cp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";
import {
  buildTestServer,
  closeServer,
  createBufferIO,
  createDashboardStub,
  createDeadApiUrl,
  fixturesRoot,
  listenOnRandomPort,
  OWNER_TOKEN,
  repoRoot,
  useCliTestEnvironment,
  withoutProfile,
} from "../test/cli-harness.js";
import { runCli } from "./main.js";

useCliTestEnvironment();
beforeEach(withoutProfile);

describe("swizzle validate", () => {
  it("validates an automation folder with a richer authoring summary", async () => {
    const io = createBufferIO();
    // A path inside the working directory prints relative to it.
    const shown = path.relative(process.cwd(), path.join(repoRoot, "infra/examples/hello-webhook"));

    const exitCode = await runCli(
      ["validate", path.join(repoRoot, "infra/examples/hello-webhook")],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toBe(
      [
        "valid: true",
        "automation:",
        "  name: hello-webhook",
        "  version: 1.0.0",
        "  entrypoint: main.py",
        "  trigger: webhook (/hello)",
        "  runtime: python / host / host-default",
        "  requirements: none",
        "  secrets: none",
        "  vars: none",
        "  apiCheck: none (no secrets or connections reach an outside API)",
        "  samplePayload: sample-payload.json",
        "checks:",
        "  syntax: ok (compile)",
        "  readiness: ready (this machine)",
        "  undeclaredEnv: none",
        `help[2]: Run \`swizzle run ${shown}\` to run it locally,Run \`swizzle apply ${shown} --dry-run\` to see what a deploy changes`,
        "",
      ].join("\n"),
    );
    expect(io.stderrText).toBe("");
  });

  it("leaves the automation folder untouched when it validates a Python entrypoint", async () => {
    // vitest.config.ts redirects bytecode for the whole run; validate must not depend on it.
    vi.stubEnv("PYTHONPYCACHEPREFIX", undefined);
    const automationDirectory = await temporaryDirectory("swizzle-validate-untouched-");
    await cp(path.join(repoRoot, "infra/examples/hello-webhook"), automationDirectory, {
      recursive: true,
    });
    const before = await readdir(automationDirectory, { recursive: true });

    const exitCode = await runCli(["validate", automationDirectory], createBufferIO());

    expect(exitCode).toBe(0);
    expect(await readdir(automationDirectory, { recursive: true })).toEqual(before);
  });

  it("accepts a Python entrypoint with a BOM or a declared source encoding", async () => {
    for (const source of [
      Buffer.from("\ufeffprint('{}')\n", "utf8"),
      Buffer.concat([
        Buffer.from("# coding: latin-1\nx = '"),
        Buffer.from([0xe9]),
        Buffer.from("'\n"),
      ]),
    ]) {
      const automationDirectory = await temporaryDirectory("swizzle-validate-encoding-");
      await cp(path.join(repoRoot, "infra/examples/hello-webhook"), automationDirectory, {
        recursive: true,
      });
      await writeFile(path.join(automationDirectory, "main.py"), source);

      const exitCode = await runCli(["validate", automationDirectory], createBufferIO());

      expect(exitCode).toBe(0);
    }
  });

  it("prints machine-readable validation output", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(
      ["validate", path.join(repoRoot, "infra/examples/typescript-webhook"), "--json"],
      io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      valid: true,
      automation: {
        name: "typescript-webhook",
        version: "1.0.0",
        entrypoint: "main.ts",
        trigger: "webhook (/typescript-webhook)",
        samplePayload: "sample-payload.json",
      },
      checks: { readiness: "ready (this machine)" },
    });
    expect(io.stderrText).toBe("");
  });

  it.each(["env-scan-python", "env-scan-node"])(
    "warns for undeclared env references during validate (%s)",
    async (fixture) => {
      const io = createBufferIO();

      const exitCode = await runCli(["validate", path.join(fixturesRoot, fixture), "--json"], io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdoutText)).toMatchObject({
        checks: { undeclaredEnv: "MAX_ITEMS, OWN_EMAILS" },
        warnings: [
          "env vars MAX_ITEMS, OWN_EMAILS are referenced but undeclared: a run sees only declared secrets and vars, so they are unset at runtime",
        ],
      });
    },
  );

  it("warns for a step flow.mermaid has no node for, not for a node without a step", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(
      ["validate", path.join(fixturesRoot, "flow-drift"), "--json"],
      io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      valid: true,
      warnings: [
        'step "review" (line 7) has no node of that id in flow.mermaid; the dashboard cannot light it up.',
      ],
    });
  });

  it.each([
    ["plain", "flowchart LR\n parse --> review\n", "flowchart LR\n parse\n"],
    [
      "front matter",
      "---\ntitle: Steps\n---\nflowchart LR\n parse --> review\n",
      "---\ntitle: Steps\n---\nflowchart LR\n parse\n",
    ],
    ["semicolons", "flowchart LR; parse --> review;", "flowchart LR; parse;"],
    [
      "quoted comment marker",
      'flowchart LR\n parse["100%% complete"] --> review\n',
      'flowchart LR\n parse["100%% complete"]\n',
    ],
  ])(
    "stays silent for every step, then warns for a missing step (%s)",
    async (_, complete, partial) => {
      const directory = await temporaryDirectory("swizzle-flow-validation-");
      await cp(path.join(fixturesRoot, "flow-drift"), directory, { recursive: true });
      const matching = createBufferIO();
      await writeFile(path.join(directory, "flow.mermaid"), complete);
      expect(await runCli(["validate", directory, "--json"], matching)).toBe(0);
      expect(JSON.parse(matching.stdoutText)).toMatchObject({ valid: true });
      expect(JSON.parse(matching.stdoutText).warnings).toBeUndefined();

      const missing = createBufferIO();
      await writeFile(path.join(directory, "flow.mermaid"), partial);
      expect(await runCli(["validate", directory, "--json"], missing)).toBe(0);
      expect(JSON.parse(missing.stdoutText)).toMatchObject({
        valid: true,
        warnings: [expect.stringContaining('step "review" (line 7) has no node')],
      });
    },
  );

  it("reports remote readiness source when validate targets an API instance", async () => {
    const io = createBufferIO();
    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform: await testPlatform(),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await runCli(
      ["profile", "add", "owner", "--url", address, "--token", OWNER_TOKEN],
      createBufferIO(),
    );

    try {
      const exitCode = await runCli(
        [
          "validate",
          path.join(repoRoot, "infra/examples/typescript-webhook"),
          "--profile",
          "owner",
          "--json",
        ],
        io,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdoutText).checks.readiness).toBe("ready (the target's workers)");
    } finally {
      await app.close();
    }
  });

  it("refuses in validate a webhook path another automation holds, as apply does", async () => {
    const platform = await testPlatform();
    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await runCli(
      ["profile", "add", "owner", "--url", address, "--token", OWNER_TOKEN],
      createBufferIO(),
    );
    const helloWebhook = path.join(repoRoot, "infra/examples/hello-webhook");
    const sibling = path.join(await temporaryDirectory("swizzle-cli-path-taken-"), "hello-copy");
    await cp(helloWebhook, sibling, { recursive: true });
    const configPath = path.join(sibling, "config.yaml");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(/^name: .*$/mu, "name: hello-copy"),
    );

    try {
      await platform.deployAutomationToPlatform({
        automationDirectory: helloWebhook,
        environment: "local",
        skipReadinessCheck: true,
      });
      const own = createBufferIO();
      const taken = createBufferIO();
      const ownExit = await runCli(["validate", helloWebhook, "--profile", "owner", "--json"], own);
      const takenExit = await runCli(["validate", sibling, "--profile", "owner", "--json"], taken);

      expect(ownExit).toBe(0);
      expect(takenExit).toBe(8);
      expect(JSON.parse(taken.stdoutText)).toMatchObject({
        code: "TRIGGER_WEBHOOK_PATH_CONFLICT",
        error: "Webhook path is already claimed in environment local: /hello",
      });
    } finally {
      await app.close();
      await platform.close();
    }
  });

  it("validates a registered offline group without live heartbeats", async () => {
    const platform = await testPlatform({
      readinessWorkers: [
        {
          availability: "offline",
          instanceId: "sleeping-laptop",
          name: "laptop",
          concurrency: 1,
          profiles: [{ name: "host-default", queueName: "platform-runs--host-default" }],
          services: [],
          capabilities: {
            languages: [],
            binaries: [],
            executionModes: [],
            dependencyPackaging: { node: false, python: false },
          },
        },
      ],
    });
    const dashboard = createDashboardStub("typescript-webhook");
    const app = await buildTestServer({ platform, dashboard });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await runCli(
      ["profile", "add", "owner", "--url", address, "--token", OWNER_TOKEN],
      createBufferIO(),
    );
    try {
      const io = createBufferIO();
      expect(
        await runCli(
          [
            "validate",
            path.join(repoRoot, "infra/examples/typescript-webhook"),
            "--profile",
            "owner",
            "--json",
          ],
          io,
        ),
      ).toBe(0);
      expect(JSON.parse(io.stdoutText).checks).toEqual({
        readiness: "ready (the target's workers)",
        readinessWarnings: [
          'Every worker in group "host-default" is offline. Deploy proceeds; a run waits up to runtime.queue_timeout for one to come online and never runs in another group.',
        ],
        undeclaredEnv: "none",
      });
    } finally {
      await app.close();
      await platform.close();
    }
  });

  it("falls back to local readiness when the default profile readiness API is unreachable", async () => {
    const deadApiUrl = await createDeadApiUrl();
    const configHome = await temporaryDirectory("swizzle-cli-default-profile-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    await writeFile(
      path.join(configHome, "config.toml"),
      [
        'default_profile = "dead"',
        "",
        "[profile.dead]",
        `url = "${deadApiUrl}"`,
        'env = "local"',
        "",
      ].join("\n"),
    );

    const io = createBufferIO();
    const exitCode = await runCli(
      ["validate", path.join(repoRoot, "infra/examples/typescript-webhook"), "--json"],
      io,
    );

    const output = JSON.parse(io.stdoutText);
    expect(exitCode).toBe(0);
    expect(output.checks.readiness).toBe("ready (this machine)");
    expect(output.warnings).toEqual([
      `API at ${deadApiUrl} unreachable, so readiness was checked on this machine; pass --profile to validate against a live instance`,
    ]);
  });

  it.each([
    ["command-level", (dir: string) => ["validate", dir, "--profile", "dead", "--json"]],
    ["global", (dir: string) => ["--profile", "dead", "validate", dir, "--json"]],
  ] as const)(
    "fails validate when an explicit %s profile readiness API is unreachable",
    async (_label, buildArgs) => {
      const deadApiUrl = await createDeadApiUrl();
      const configHome = await temporaryDirectory("swizzle-cli-explicit-profile-");
      vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
      await writeFile(
        path.join(configHome, "config.toml"),
        ["[profile.dead]", `url = "${deadApiUrl}"`, 'env = "local"', ""].join("\n"),
      );

      const io = createBufferIO();
      const exitCode = await runCli(
        buildArgs(path.join(repoRoot, "infra/examples/typescript-webhook")),
        io,
      );

      expect(exitCode).toBe(5);
      expect(JSON.parse(io.stdoutText).code).toBe("API_UNREACHABLE");
    },
  );

  it("falls back when the default profile readiness API returns 5xx", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: "OPS_SUMMARY_FAILED", message: "ops summary unavailable" }),
      );
    });
    const apiUrl = await listenOnRandomPort(server);
    const configHome = await temporaryDirectory("swizzle-cli-default-profile-5xx-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    await writeFile(
      path.join(configHome, "config.toml"),
      [
        'default_profile = "failing"',
        "",
        "[profile.failing]",
        `url = "${apiUrl}"`,
        'env = "local"',
        "",
      ].join("\n"),
    );

    try {
      const io = createBufferIO();
      const exitCode = await runCli(
        ["validate", path.join(repoRoot, "infra/examples/typescript-webhook"), "--json"],
        io,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdoutText)).toMatchObject({
        checks: { readiness: "ready (this machine)" },
        warnings: [expect.stringContaining(`API at ${apiUrl} unreachable`)],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("does not fall back when the default profile readiness API returns 4xx", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "UNAUTHORIZED", message: "Missing bearer token" }));
    });
    const apiUrl = await listenOnRandomPort(server);
    const configHome = await temporaryDirectory("swizzle-cli-default-profile-4xx-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    await writeFile(
      path.join(configHome, "config.toml"),
      [
        'default_profile = "needs-token"',
        "",
        "[profile.needs-token]",
        `url = "${apiUrl}"`,
        'env = "local"',
        "",
      ].join("\n"),
    );

    try {
      const io = createBufferIO();
      const exitCode = await runCli(
        ["validate", path.join(repoRoot, "infra/examples/typescript-webhook"), "--json"],
        io,
      );

      expect(exitCode).toBe(4);
      expect(JSON.parse(io.stdoutText).code).toBe("UNAUTHORIZED");
    } finally {
      await closeServer(server);
    }
  });

  it("fails validate on Python syntax errors", async () => {
    const directory = await temporaryDirectory("swizzle-cli-python-syntax-");
    await writeFile(
      path.join(directory, "config.yaml"),
      [
        "name: bad-python",
        "version: 1.0.0",
        "entrypoint: main.py",
        "trigger:",
        "  type: cron",
        "  schedule: '* * * * *'",
        "runtime:",
        "  language: python",
        "  execution_mode: host",
        "  profile: host-default",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(directory, "main.py"), "def nope(:\n", "utf8");

    const io = createBufferIO();
    const exitCode = await runCli(["validate", directory, "--json"], io);

    expect(exitCode).toBe(3);
    expect(JSON.parse(io.stdoutText)).toEqual({
      error: `${path.join(directory, "main.py")}:1:10: invalid syntax`,
      code: "PYTHON_SYNTAX_INVALID",
      help: ["Fix the Python syntax error, then rerun `swizzle validate`."],
    });
  });

  it("validates container execution mode", async () => {
    const directory = await temporaryDirectory("swizzle-cli-container-");
    await writeFile(
      path.join(directory, "config.yaml"),
      [
        "name: container-mode",
        "version: 1.0.0",
        "entrypoint: main.py",
        "trigger:",
        "  type: cron",
        "  schedule: '* * * * *'",
        "runtime:",
        "  language: python",
        "  execution_mode: container",
        "  profile: host-default",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(directory, "main.py"), "print('{}')\n", "utf8");

    const io = createBufferIO();
    const exitCode = await runCli(["validate", directory, "--json"], io);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      valid: true,
      automation: { runtime: "python / container / host-default" },
    });
  });

  it("passes bundle dry-run validation for a valid typescript automation", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(
      ["validate", path.join(repoRoot, "infra/examples/typescript-webhook"), "--bundle", "--json"],
      io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      valid: true,
      checks: { bundle: "ok (esm)" },
    });
  });

  it("validates top-level await as Node runs it: ESM unless package.json says commonjs", async () => {
    const directory = await temporaryDirectory("swizzle-cli-validate-bundle-tla-");

    await writeFile(
      path.join(directory, "config.yaml"),
      [
        "name: tla",
        "version: 1.0.0",
        "description: Top-level await fixture",
        "entrypoint: main.ts",
        "trigger:",
        "  type: webhook",
        "  path: /tla",
        "runtime:",
        "  language: typescript",
        "  execution_mode: host",
        "  profile: host-default",
        "  timeout: 30s",
        "  permissions:",
        "    network: false",
        "    writable_dirs: []",
        "  retry:",
        "    max_attempts: 1",
        "    backoff: exponential",
        "  requirements:",
        "    binaries: []",
        "secrets: []",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(directory, "main.ts"), "await Promise.resolve();\n", "utf8");

    const esm = createBufferIO();
    expect(await runCli(["validate", directory, "--bundle", "--json"], esm)).toBe(0);
    expect(JSON.parse(esm.stdoutText).checks.bundle).toBe("ok (esm)");

    await writeFile(path.join(directory, "package.json"), '{ "type": "commonjs" }\n', "utf8");
    const cjs = createBufferIO();
    expect(await runCli(["validate", directory, "--bundle"], cjs)).toBe(3);
    expect(cjs.stdoutText).toContain(
      'Top-level await is currently not supported with the \\"cjs\\" output format',
    );
  });

  it("fails validate --bundle with syntax errors and preserves location pointers", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-validate-bundle-syntax-");

    await writeFile(
      path.join(directory, "config.yaml"),
      [
        "name: broken-syntax",
        "version: 1.0.0",
        "description: Broken syntax fixture",
        "entrypoint: main.ts",
        "trigger:",
        "  type: webhook",
        "  path: /broken-syntax",
        "runtime:",
        "  language: typescript",
        "  execution_mode: host",
        "  profile: host-default",
        "  timeout: 30s",
        "  permissions:",
        "    network: false",
        "    writable_dirs: []",
        "  retry:",
        "    max_attempts: 1",
        "    backoff: exponential",
        "  requirements:",
        "    binaries: []",
        "secrets: []",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify(
        { name: "broken-syntax", private: true, type: "module", version: "1.0.0" },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(path.join(directory, "main.ts"), "export const broken = ;\n", "utf8");

    const exitCode = await runCli(["validate", directory, "--bundle"], io);

    expect(exitCode).toBe(3);
    expect(io.stdoutText).toContain(
      'error: "main.ts:1:22: Unexpected \\";\\""\ncode: VALIDATE_BUNDLE_FAILED\n',
    );
  });

  it("surfaces actionable errors for invalid automation folders", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(["validate", path.join(fixturesRoot, "missing-entrypoint")], io);

    expect(exitCode).toBe(6);
    expect(io.stdoutText).toBe(
      [
        "error: \"Entrypoint file 'main.py' not found in bundle. Check `entrypoint:` in config.yaml and that the file is not excluded by .swizzleignore.\"",
        "code: AUTOMATION_ENTRYPOINT_NOT_FOUND",
        "details:",
        "  entrypoint: main.py",
        "help[1]: Create the entrypoint file or update config.yaml `entrypoint` to the correct relative path.",
        "",
      ].join("\n"),
    );
    expect(io.stderrText).toBe("");
  });
});

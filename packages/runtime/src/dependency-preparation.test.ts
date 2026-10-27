import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { temporaryDirectory } from "../../../test/support.js";
import { buildDependencyInstallEnvironment } from "./dependency-preparation.js";
import { runAutomation } from "./runner.js";

describe("dependency preparation security", () => {
  it("does not expose control-plane credentials or automation secrets to installers", () => {
    const environment = buildDependencyInstallEnvironment(
      {
        AUTOMATION_SECRET: "must-not-leak",
        SWIZZLE_ENCRYPTION_KEY: "must-not-leak",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
        DATABASE_URL: "postgresql://must-not-leak",
        HOME: "/home/operator",
        PATH: "/usr/local/bin:/usr/bin",
        VALKEY_URL: "redis://must-not-leak",
      },
      "/safe/cache",
    );

    expect(environment).toMatchObject({
      CI: "true",
      HOME: "/safe/cache/installer-home",
      PATH: "/usr/local/bin:/usr/bin",
      npm_config_ignore_scripts: "true",
    });
    expect(environment).not.toHaveProperty("AUTOMATION_SECRET");
    expect(environment).not.toHaveProperty("SWIZZLE_ENCRYPTION_KEY");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("DATABASE_URL");
    expect(environment).not.toHaveProperty("VALKEY_URL");
  });
});

describe("python dependency cache", () => {
  // One venv build is the slowest step in the unit tier, so this test builds it once and
  // proves the worker reuses it through the cache root in its own process env. The build costs
  // about 3 s of CPU (ensurepip and pip) and the test up to 5 s with both runs. The budget lets a
  // loaded host give it a tenth of a core.
  it("installs once, then a worker run with a sanitized child env reuses the cached venv", {
    timeout: 50_000,
  }, async () => {
    const automationDirectory = await temporaryDirectory("swizzle-python-deps-");
    const cacheDirectory = await temporaryDirectory("swizzle-dep-cache-");
    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      `name: python-deps
version: 1.0.0
entrypoint: main.py
trigger:
  type: webhook
runtime:
  language: python
  requirements:
    python:
      requirements_file: requirements.txt
`,
    );
    await writeFile(path.join(automationDirectory, "requirements.txt"), "");
    await writeFile(
      path.join(automationDirectory, "main.py"),
      // sys.prefix names the interpreter's own environment, so it proves the venv runs, not only its env var.
      'import json, sys\njson.dump({"prefix": sys.prefix}, sys.stdout)\n',
    );

    // The cache root is operator configuration, read from the process env for both modes.
    vi.stubEnv("SWIZZLE_DEP_CACHE_DIR", cacheDirectory);
    const local = await runAutomation({
      environmentName: "local",
      automationDirectory,
      environment: { PATH: process.env.PATH },
    });
    const worker = await runAutomation({
      environmentName: "local",
      automationDirectory,
      environment: { PATH: process.env.PATH },
      runtimeMetadata: {
        automationName: "python-deps",
      },
    });

    expect(local).toMatchObject({
      result: { prefix: expect.stringContaining(cacheDirectory) },
      stderr: expect.stringContaining("installing Python dependencies into local cache"),
      success: true,
    });
    expect(worker).toMatchObject({
      // The same interpreter: the worker run reused the venv the local run built.
      result: local.success ? local.result : null,
      stderr: expect.stringContaining("Python dependency cache hit"),
      success: true,
    });
  });
});

describe("worker dependency cache location", () => {
  it("fails with a named error instead of caching in the current directory", async () => {
    const automationDirectory = await temporaryDirectory("swizzle-no-cache-dir-");
    await writeFile(
      path.join(automationDirectory, "config.yaml"),
      "name: no-cache-dir\nversion: 1.0.0\nentrypoint: main.py\ntrigger:\n  type: webhook\n",
    );
    await writeFile(path.join(automationDirectory, "main.py"), "print('{}')\n");
    vi.stubEnv("SWIZZLE_DEP_CACHE_DIR", undefined);
    vi.stubEnv("SWIZZLE_ARTIFACTS_DIR", undefined);

    const result = await runAutomation({
      environmentName: "local",
      automationDirectory,
      environment: { PATH: process.env.PATH },
      runtimeMetadata: {
        automationName: "no-cache-dir",
      },
    });

    expect(result).toMatchObject({ code: "DEPENDENCY_CACHE_DIR_MISSING", success: false });
    expect(existsSync(path.resolve(".swizzle", "dep-cache"))).toBe(false);
  });
});

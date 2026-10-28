import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";

it.each(["v25.03.0", "latest", "25"])(
  "runs and checks saved binary rule %s with its deployed matcher",
  async (rule) => {
    const bin = await temporaryDirectory("swizzle-legacy-binary-");
    await writeFile(path.join(bin, "pdftoppm"), '#!/bin/sh\necho "pdftoppm version 25.03.0"\n', {
      mode: 0o755,
    });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    const platform = await testPlatform();
    const directory = await createAutomationFixture({
      name: "legacy-binary",
      triggerLines: ["  type: webhook", "  path: /legacy-binary"],
      configLines: [
        "api_check: { mode: active, entrypoint: check.js }",
        "runtime:",
        "  requirements:",
        "    binaries:",
        '      - { name: pdftoppm, version: "25" }',
      ],
    });
    await writeFile(path.join(directory, "check.js"), "console.log('{\"ok\":true}');\n");
    const deployed = await platform.deployAutomationToPlatform({
      automationDirectory: directory,
      environment: "local",
    });
    const configPath = path.join(deployed.sourceDirectory, "config.yaml");
    // A freshly validated prefix must keep its matcher after artifact reload.
    await platform.triggerWebhookByPath({
      environment: "local",
      path: "/legacy-binary",
      payload: {},
    });
    expect(await platform.processNextPlatformRun()).toMatchObject({
      status: "succeeded",
      result: { ok: true },
    });
    // Earlier releases saved the rule without a matcher revision in both config copies.
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8"))
        .replace('"25"', `"${rule}"`)
        .replace(/^\s*binary_version_matching:.*\n/mu, ""),
    );
    const pool = testDatabase().pool;
    await pool.query(
      `UPDATE automation_versions SET config = jsonb_set(config #- '{runtime,binary_version_matching}',
      '{runtime,requirements,binaries,0,version}', $2::jsonb) WHERE id = $1`,
      [deployed.versionId, JSON.stringify(rule)],
    );
    // The worker reports the binary that this fixture put on its PATH.
    await pool.query(`UPDATE workers SET capabilities = jsonb_set(capabilities, '{binaries}',
    (capabilities->'binaries') || '[{"name":"pdftoppm","version":"25.03.0"}]')`);

    if (rule === "25") {
      expect(await platform.getAutomationDeployment("legacy-binary", "local")).toMatchObject({
        readiness: { status: "not-ready", errors: [{ code: "BINARY_VERSION_UNSUPPORTED" }] },
      });
      return;
    }

    expect(await platform.getAutomationDeployment("legacy-binary", "local")).toMatchObject({
      readiness: { status: "ready" },
    });
    await platform.triggerWebhookByPath({
      environment: "local",
      path: "/legacy-binary",
      payload: {},
    });
    expect(await platform.processNextPlatformRun()).toMatchObject({
      status: "succeeded",
      result: { ok: true },
    });
    const [check] = await platform.store.listDueAutomationChecks(new Date().toISOString(), "local");
    if (check === undefined) throw new Error("Expected a due legacy deployment check");
    expect(await platform.processPlatformCheck(check.checkId, check.nextCheckAt)).toMatchObject({
      status: "green",
      lastExitCode: 0,
      lastGreenReport: { ok: true },
    });
  },
);

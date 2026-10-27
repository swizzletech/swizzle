import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { contractChangeFailure } from "./api-signals.js";
import { checkOutcome } from "./check-contract.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const change = { api: "api.example.com", expected: "number", field: "amount", got: "string" };

describe("SDK contract changes", () => {
  it.each(["typescript", "python"])(
    "%s emits the same contract event for checks and runs",
    (language) => {
      const command = language === "typescript" ? process.execPath : "python3";
      const args =
        language === "typescript"
          ? [
              "--experimental-strip-types",
              "--disable-warning=ExperimentalWarning",
              "--input-type=module",
              "-e",
              `import { contractChanged } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/sdk-ts/src/index.ts")).href)}; contractChanged(${JSON.stringify(change)});`,
            ]
          : [
              "-c",
              'from swizzle_sdk import contract_changed; contract_changed("api.example.com", "amount", "number", "string")',
            ];
      const run = (trigger: string) =>
        spawnSync(command, args, {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONPATH: path.join(root, "packages/sdk-py"),
            SWIZZLE_TRIGGER_TYPE: trigger,
          },
        });
      const check = run("check");
      expect(check.status).toBe(1);
      expect(check.stdout).toBe("");
      expect(JSON.parse(check.stderr)).toEqual({ ...change, type: "contract_changed" });
      expect(
        checkOutcome({
          success: false,
          code: "PROCESS_EXIT_NON_ZERO",
          exitCode: check.status,
          message: "exit 1",
          stdout: check.stdout,
          stderr: check.stderr,
        }),
      ).toMatchObject({
        status: "drift",
        report: { ok: false, checked: [], change },
      });

      const execution = run("webhook");
      expect(execution.status).toBe(1);
      expect(execution.stdout).toBe("");
      expect(contractChangeFailure(execution.stderr)).toEqual({
        code: "UPSTREAM_CONTRACT_CHANGED",
        message: "The API of api.example.com changed: amount is string, expected number.",
      });
    },
  );
});

describe("checkOutcome", () => {
  it("keeps the typed report whole when diagnostic output is truncated", () => {
    const result = {
      ok: true,
      checked: ["GET /deals", 42, "GET /accounts"],
      detail: "x".repeat(9000),
    };
    const outcome = checkOutcome({
      success: true,
      result,
      stdout: JSON.stringify(result),
      stderr: "",
    });
    expect(outcome.status).toBe("green");
    expect(outcome.report).toEqual({
      ok: true,
      checked: ["GET /deals", "GET /accounts"],
      change: null,
    });
    expect(outcome.output?.length).toBe(8192);
  });

  it("keeps exit 1 as drift with no report, and other exits as undecided even with ok on stdout", () => {
    const failure = {
      success: false,
      code: "PROCESS_EXIT_NON_ZERO",
      exitCode: 1,
      message: "exit 1",
      stdout: "not JSON",
      stderr: "",
    } as const;
    expect(checkOutcome(failure)).toMatchObject({
      status: "drift",
      report: { ok: false, checked: [], change: null },
    });
    expect(checkOutcome({ ...failure, exitCode: 2, stdout: '{"ok":true}' })).toMatchObject({
      status: "error",
      exitCode: 2,
      report: { ok: true, checked: [], change: null },
    });
  });
});

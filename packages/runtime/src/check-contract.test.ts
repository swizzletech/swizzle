import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";

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

it.each([
  [
    "Traceback (most recent call last):\n  File \"check.py\", line 3, in <module>\nKeyError: 'amount'\n",
    "KeyError: 'amount' at check.py:3",
  ],
  [
    "imaplib.IMAP4.error: [AUTHENTICATIONFAILED] Invalid credentials\n",
    "API check credentials failed: imaplib.IMAP4.error: [AUTHENTICATIONFAILED] Invalid credentials",
  ],
  ["HTTPError: 401 Unauthorized\n", "API check credentials failed: HTTPError: 401 Unauthorized"],
  [
    "Error: Request failed with status 403\n    at check (/app/check.js:8:3)\n",
    "API check credentials failed: Error: Request failed with status 403",
  ],
])("reports a crashed or unauthenticated exit 1 as an error", (stderr, message) => {
  expect(
    checkOutcome({
      success: false,
      code: "PROCESS_EXIT_NON_ZERO",
      exitCode: 1,
      message: "exit 1",
      stdout: "",
      stderr,
    }),
  ).toMatchObject({ status: "error", message });
});

it("keeps an incomplete traceback out of drift", () => {
  expect(
    checkOutcome({
      success: false,
      code: "PROCESS_EXIT_NON_ZERO",
      exitCode: 1,
      message: "exit 1",
      stdout: "",
      stderr: 'Traceback (most recent call last):\n  File "check.py", line 3, in <module>\n',
    }),
  ).toMatchObject({ status: "error" });
});

it.each([
  [
    'throw "login request failed";',
    { status: "error", message: "login request failed at check.js:9" },
  ],
  [
    'throw "/upstream/api.js:12";',
    { status: "error", message: "/upstream/api.js:12 at check.js:9" },
  ],
  ["process.exit(1);", { status: "drift" }],
])("distinguishes an uncaught Node value from intentional exit 1: %s", async (source, expected) => {
  const directory = await temporaryDirectory("swizzle-node-check-");
  const entrypoint = path.join(directory, "check.js");
  await writeFile(entrypoint, `${"\n".repeat(8)}${source}\n`);
  const crashed = spawnSync(process.execPath, [entrypoint], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(crashed.status).toBe(1);
  expect(
    checkOutcome({
      success: false,
      code: "PROCESS_EXIT_NON_ZERO",
      exitCode: crashed.status,
      message: "exit 1",
      stdout: crashed.stdout,
      stderr: crashed.stderr,
    }),
  ).toMatchObject(expected);
});

it.each([1, 10_000])("keeps repeated HTTP markers without a status as drift: %i", (count) => {
  expect(
    checkOutcome({
      success: false,
      code: "PROCESS_EXIT_NON_ZERO",
      exitCode: 1,
      message: "exit 1",
      stdout: "",
      stderr: "http".repeat(count),
    }),
  ).toMatchObject({ status: "drift", report: { ok: false, checked: [], change: null } });
});

it.each([1, 10_000])(
  "keeps stack-frame indentation on its own line with %i blank lines",
  (count) => {
    for (const [tail, status] of [
      ["at check (/app/check.js:8:3)", "drift"],
      [" \tat check (/app/check.js:8:3)", "error"],
      ["contract changed", "drift"],
    ] as const) {
      expect(
        checkOutcome({
          success: false,
          code: "PROCESS_EXIT_NON_ZERO",
          exitCode: 1,
          message: "exit 1",
          stdout: "",
          stderr: "\n".repeat(count) + tail,
        }),
      ).toMatchObject({ status, report: { ok: false, checked: [], change: null } });
    }
  },
);

it.each([
  ["HTTP 200 GET /orders/401", { status: "drift" }],
  ["HTTP 200 GET /status:401", { status: "drift" }],
  ["HTTP 200 GET /response:403", { status: "drift" }],
  ["HTTP 200 GET /HTTP:401", { status: "drift" }],
  ["HTTP 200 GET /orders?status:401", { status: "drift" }],
  ["HTTP 401", { status: "error", failure: "credentials" }],
  ["response 200 GET /orders/403", { status: "drift" }],
  ["status 200 GET /orders/401", { status: "drift" }],
  ["HTTP/1.1 403", { status: "error", failure: "credentials" }],
  ["HTTP/1.1 200 GET /orders/403", { status: "drift" }],
  ["HTTP/2 401", { status: "error", failure: "credentials" }],
  ["HTTP/2 200 GET /orders/401", { status: "drift" }],
  ["status code: 401", { status: "error", failure: "credentials" }],
  ["status code: 200 GET /orders/401", { status: "drift" }],
  ["response: 403", { status: "error", failure: "credentials" }],
  ["401 response", { status: "drift" }],
  ["HTTP401", { status: "drift" }],
  ["HTTP 401K", { status: "drift" }],
  ["401 response 503", { status: "drift" }],
  ["401 response 403", { status: "error", failure: "credentials" }],
  ["http".repeat(10_000) + " 401", { status: "error", failure: "credentials" }],
])("preserves credential marker order and status boundaries (case %#)", (stderr, expected) => {
  expect(
    checkOutcome({
      success: false,
      code: "PROCESS_EXIT_NON_ZERO",
      exitCode: 1,
      message: "exit 1",
      stdout: "",
      stderr,
    }),
  ).toMatchObject(expected);
});

it.each(["HTTP 401 ", "Error: "])("bounds a long diagnostic from %s", (prefix) => {
  const outcome = checkOutcome({
    success: false,
    code: "PROCESS_EXIT_NON_ZERO",
    exitCode: 1,
    message: "exit 1",
    stdout: "",
    stderr: `${prefix}${"x".repeat(10_000)}\n    at check (/app/check.js:8:3)`,
  });
  expect(outcome.status).toBe("error");
  if (outcome.status !== "error") throw new Error("Expected a diagnostic error");
  expect(outcome.message).toContain(prefix);
  expect(outcome.message.length).toBeLessThanOrEqual(4096);
});

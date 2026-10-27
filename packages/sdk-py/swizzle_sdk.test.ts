import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sdkDirectory = path.dirname(fileURLToPath(import.meta.url));

function runPython(code: string) {
  return spawnSync("python3", ["-c", code], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: sdkDirectory },
  });
}

describe("log_step", () => {
  it("writes details as one structured line", () => {
    const run = runPython('import swizzle_sdk; swizzle_sdk.log_step("saw", {"ratio": 0.5})');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stderr)).toMatchObject({
      details: { ratio: 0.5 },
      message: "saw",
      type: "step",
    });
  });

  // json.dumps writes a bare NaN token, which the runtime cannot parse as a structured line.
  it("refuses a NaN in the details instead of writing a line the runtime cannot parse", () => {
    const run = runPython(
      'import swizzle_sdk; swizzle_sdk.log_step("saw", {"ratio": float("nan")})',
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "ValueError: Swizzle log details is not JSON: Out of range float values are not JSON compliant: nan",
    );
  });
});

describe("claim", () => {
  // A step under a claim's name would answer claim() without asking the platform.
  it("refuses a step named like a claim", () => {
    const run = runPython(
      'import swizzle_sdk; swizzle_sdk.run_step("claim:order:A-1001", lambda: {"claimed": True})',
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      "ValueError: Swizzle step names starting with 'claim:' are reserved for claim().",
    );
  });
});

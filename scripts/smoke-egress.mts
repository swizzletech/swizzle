// Deploy both SDKs through the packaged runner and assert public HTTPS works while private egress fails.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { get, type PackagedStack, until } from "./packaged-stack.mts";

const PYTHON = `import json
from swizzle_sdk import api_request
response = api_request("https://api.github.com/user", headers={"User-Agent": "swizzle-egress-smoke"})
assert 100 <= response.status <= 599, response.status
try:
    api_request("http://127.0.0.1:80")
except Exception:
    denied = True
else:
    raise AssertionError("Private egress was allowed")
print(json.dumps({"status": response.status, "privateDenied": denied}))
`;

const TYPESCRIPT = `import { apiFetch } from "./swizzle-sdk.ts";
const response = await apiFetch("https://api.github.com/user", { headers: { "User-Agent": "swizzle-egress-smoke" } });
if (response.status < 100 || response.status > 599) throw new Error("No HTTP response");
let denied = false;
try {
  await apiFetch("http://127.0.0.1:80");
} catch {
  denied = true;
}
if (!denied) throw new Error("Private egress was allowed");
console.log(JSON.stringify({ status: response.status, privateDenied: denied }));
`;

export async function smokeRunnerEgress(
  stack: PackagedStack,
  log: (message: string) => void,
): Promise<void> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "swizzle-smoke-egress-"));
  try {
    let deniedRequests = 0;
    for (const [language, entrypoint, sdk, sdkName, body] of [
      ["python", "main.py", "packages/sdk-py/swizzle_sdk.py", "swizzle_sdk.py", PYTHON],
      ["typescript", "main.ts", "packages/sdk-ts/src/index.ts", "swizzle-sdk.ts", TYPESCRIPT],
    ] as const) {
      const name = `egress-${language}`;
      const directory = path.join(scratch, name);
      await mkdir(directory);
      await cp(sdk, path.join(directory, sdkName));
      await writeFile(path.join(directory, entrypoint), body);
      await writeFile(
        path.join(directory, "config.yaml"),
        `name: ${name}\nversion: 1.0.0\nentrypoint: ${entrypoint}\ntrigger: { type: webhook, path: /hooks/${name} }\nruntime:\n  language: ${language}\n  retry: { max_attempts: 1 }\n`,
      );
      await stack.cli("apply", directory);
      const response = await fetch(`${stack.links}/hooks/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200, await response.clone().text());
      const queued: unknown = await response.json();
      assert.ok(queued !== null && typeof queued === "object" && "runId" in queued);
      assert.equal(typeof queued.runId, "string");
      const runId = queued.runId;
      const run = await until(
        `${name} run ${runId} finished`,
        async () => {
          const body = await get(
            `${stack.dashboard}/api/runs/${runId}?environment=${stack.environment}`,
            stack.token,
          );
          if (body === undefined) return undefined;
          const run: unknown = JSON.parse(body);
          assert.ok(run !== null && typeof run === "object" && "status" in run);
          return ["succeeded", "failed", "dead-lettered"].includes(String(run.status))
            ? run
            : undefined;
        },
        log,
      );
      log(`${name}: ${JSON.stringify(run)}`);
      assert.equal(run.status, "succeeded", JSON.stringify(run));
      assert.ok("result" in run && run.result !== null && typeof run.result === "object");
      const result = run.result;
      assert.ok("status" in result && typeof result.status === "number");
      assert.ok(Number.isInteger(result.status) && result.status >= 100 && result.status <= 599);
      assert.ok("privateDenied" in result);
      assert.equal(result.privateDenied, true);
      deniedRequests += 1;
      await until(
        `${name} private request was denied by the proxy`,
        async () => {
          const logs = await stack.compose("logs", "--no-color", "runner-egress-proxy");
          const denials = logs.match(/TCP_DENIED\/403[^\n]*CONNECT 127\.0\.0\.1:80 /gu) ?? [];
          return denials.length === deniedRequests ? true : undefined;
        },
        log,
      );
      log(`${name}: received HTTP ${result.status}; proxy refused private CONNECT with 403`);
    }
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

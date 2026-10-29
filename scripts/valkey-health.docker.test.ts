import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { temporaryDirectory, waitFor } from "../test/support.js";
import { ensureEnvFile, packagedStackValues } from "./env-file.ts";
import { readCompose } from "./stack-images.ts";

const execute = promisify(execFile);

for (const authentication of ["correct", "wrong", "empty"] as const) {
  it(`the packaged Valkey probe reports ${authentication} authentication correctly`, async ({
    signal,
  }) => {
    const directory = await temporaryDirectory("swizzle-valkey-health-");
    const values = packagedStackValues(`swizzle-valkey-${randomUUID()}`);
    const envFile = path.join(directory, ".env");
    await ensureEnvFile(envFile, await readFile(".env.example", "utf8"), values);
    const { valkey } = readCompose({ root: process.cwd(), envFile }).services;
    if (valkey === undefined) throw new Error("No packaged Valkey service.");
    const health = valkey.healthcheck;
    assert.ok(health !== null && typeof health === "object" && "test" in health);
    assert.ok(Array.isArray(health.test) && typeof health.test[1] === "string");
    const container = `swizzle-valkey-health-${randomUUID()}`;
    const password = { correct: values.VALKEY_PASSWORD, wrong: "wrong", empty: "" }[authentication];
    try {
      await execute("docker", [
        "run",
        "--detach",
        "--name",
        container,
        "--network",
        "none",
        "--env",
        `VALKEY_PASSWORD=${password}`,
        "--health-cmd",
        health.test[1].replaceAll("$$", "$"),
        "--health-interval",
        "100ms",
        "--health-retries",
        "1",
        String(valkey.image),
        "valkey-server",
        "--requirepass",
        values.VALKEY_PASSWORD,
      ]);
      await waitFor(signal, async () => {
        const response = await execute("docker", [
          "exec",
          container,
          "valkey-cli",
          "--no-auth-warning",
          "-a",
          values.VALKEY_PASSWORD,
          "ping",
        ]).catch(() => ({ stdout: "" }));
        return response.stdout.trim() === "PONG";
      });
      // Two completed probes ensure the last started after readiness, even if one was in flight.
      const state = async () => {
        const health: { Status: string; Log: { Start: string }[] } = JSON.parse(
          (await execute("docker", ["inspect", "--format", "{{json .State.Health}}", container]))
            .stdout,
        );
        return health;
      };
      let observed = await state();
      for (const _ of [0, 1]) {
        const previous = observed.Log.at(-1)?.Start;
        await waitFor(signal, async () => {
          observed = await state();
          return observed.Log.at(-1)?.Start !== previous;
        });
      }
      expect(observed.Status).toBe(authentication === "correct" ? "healthy" : "unhealthy");
    } finally {
      await execute("docker", ["rm", "--force", "--volumes", container]);
    }
  });
}

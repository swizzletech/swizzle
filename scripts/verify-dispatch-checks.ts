import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import { createPostgresControlPlaneStore } from "@swizzle/db/postgres";
import type { DispatchFixture } from "./verify-dispatch-fixture.js";

export async function verifyChecks(
  fixture: DispatchFixture,
  setScenario: (scenario: string) => void,
) {
  const { client, id, profile, directory, platform, issue, pull, execute, finish } = fixture;
  const a = await issue("worker-a");
  await writeFile(path.join(directory, "main.js"), 'console.log("{}");');
  setScenario("HTTP API checks");
  const checkName = `check-protocol-${id}`;
  await platform.upsertSecret("CHECK_KEY", "scoped-check-value", {
    environment: "local",
    projectId: DEFAULT_PROJECT_ID,
  });
  const checkStore = createPostgresControlPlaneStore({ client });
  const connection = await checkStore.beginConnectionAuthorization({
    clientId: "check-client",
    clientSecret: "check-client-secret",
    codeVerifier: "check-verifier",
    environment: "local",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    name: "check-oauth",
    projectId: DEFAULT_PROJECT_ID,
    provider: "google",
    reauthorizes: null,
    redirectUri: "https://api.example.com/connections/google/callback",
    scopes: [],
    stateHash: `check-state-${id}`,
  });
  await checkStore.storeConnectionTokens({
    connectionId: connection.id,
    payload: {
      accessToken: "check-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      obtainedAt: new Date().toISOString(),
      refreshToken: null,
      tokenType: "Bearer",
    },
  });
  await writeFile(
    path.join(directory, "config.yaml"),
    `name: ${checkName}\nversion: 1.0.0\nentrypoint: main.js\nsecrets: [CHECK_KEY]\nconnections: [check-oauth]\ntrigger:\n  type: webhook\n  path: /${checkName}\nruntime:\n  profile: ${profile}\napi_check:\n  mode: active\n  entrypoint: check.js\n`,
  );
  await writeFile(
    path.join(directory, "check.js"),
    `console.log(JSON.stringify({ok:process.env.CHECK_KEY==='scoped-check-value',checked:['declared secret'],infrastructure:!!(process.env.DATABASE_URL||process.env.VALKEY_URL||process.env.SWIZZLE_ENCRYPTION_KEY),state:!!(process.env.SWIZZLE_STATE_FILE||process.env.SWIZZLE_STEPS_FILE)}));`,
  );
  await platform.deployAutomationToPlatform({
    automationDirectory: directory,
    environment: "local",
  });
  assert.equal(await platform.enqueueDueApiChecks({ environment: "local" }), 1);
  const check = await pull(a);
  assert.ok(check !== null);
  assert.equal(check.script, "check");
  assert.ok(check.lease.checkId !== null);
  const checkReport = await execute(a, check);
  assert.deepEqual(JSON.parse(checkReport.stdout), {
    ok: true,
    checked: ["declared secret"],
    infrastructure: false,
    state: false,
  });
  await finish(a, check, checkReport);
  const recorded = await checkStore.getAutomationCheck(check.lease.checkId);
  assert.ok(recorded !== null);
  assert.equal(recorded.status, "green");
  assert.equal(recorded.lastSecretUsages[0]?.secretName, "CHECK_KEY");
  assert.deepEqual(
    recorded.lastConnectionUsages.map(({ injectedAt: _, ...usage }) => usage),
    [
      {
        connectionName: "check-oauth",
        environment: "local",
        provider: "google",
        tokenVersion: 1,
      },
    ],
  );
  console.log(
    "A4 checks: same HTTP protocol executes an active check with declared secrets, no infrastructure credentials, and no state/step files, and records the connection token version it received.",
  );
}

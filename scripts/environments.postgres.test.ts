import assert from "node:assert/strict";
import { createPostgresEnvironmentStore, type DatabaseClient } from "@swizzle/db/postgres";
import { it } from "vitest";
import { testDatabase } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
import { commitDeploymentFixture } from "./verify-state-fixtures.js";

async function verifyEnvironments(client: DatabaseClient): Promise<void> {
  const environments = createPostgresEnvironmentStore({ client });
  const created = await environments.createEnvironment({
    name: " store-check ",
    displayName: " Store check ",
    description: " Kept on update ",
  });
  assert.equal(created.name, "store-check");
  assert.equal(created.displayName, "Store check");
  assert.equal(created.registered, true);
  assert.equal(created.hasData, false);
  const updated = await environments.createEnvironment({ name: "store-check", displayName: null });
  assert.equal(updated.displayName, null);
  assert.equal(updated.description, "Kept on update");
  assert.equal(updated.createdAt, created.createdAt);
  const listed = await environments.listEnvironments();
  assert.equal(listed.filter(({ name }) => name === "store-check").length, 1);
  // State-machine deployments discover an environment even when it is not registered explicitly.
  const discovered = listed.find(({ name }) => name === "state-machine");
  assert.equal(discovered?.registered, false);
  assert.equal(discovered?.hasData, true);
  const registered = await environments.createEnvironment({ name: "state-machine" });
  assert.equal(registered.registered, true);
  assert.equal(registered.hasData, true);
  await assert.rejects(environments.createEnvironment({ name: "invalid name" }), {
    code: "ENVIRONMENT_NAME_INVALID",
  });
  process.stdout.write(
    "Postgres environments: registration, updates and discovered data passed.\n",
  );
}

it("environments", { timeout: 60_000 }, async () => {
  const client = testDatabase();
  await commitDeploymentFixture(testControlPlaneStore(), "discovered");
  await verifyEnvironments(client);
});

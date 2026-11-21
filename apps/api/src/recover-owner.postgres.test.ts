import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, onTestFinished, vi } from "vitest";
import { testDatabase } from "../../../test/postgres.js";
import { testAuditStore } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY } from "../../../test/support.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

it("writes the host audit event before owner recovery revokes the session", async () => {
  vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  const database = testDatabase();
  const people = testPeople(database);
  const email = "owner@example.test";
  const password = "a long enough test passphrase";
  await people.add(email, { password, role: "owner" });
  const app = await buildTestServer({ auth: people.auth, database });
  onTestFinished(() => app.close());
  const browser = testBrowser(app);
  expect((await browser.signIn(email, password)).statusCode).toBe(200);
  expect((await browser.send("GET", "/auth/status")).json()).toMatchObject({ authenticated: true });

  await database.pool.query(`
    CREATE FUNCTION require_recovery_audit_before_session_revocation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM audit_events
        WHERE action = 'recover-owner' AND actor_kind = 'host'
          AND params->>'email' = (SELECT email FROM auth_users WHERE id = OLD.user_id)
          AND status IS NULL
      ) THEN
        RAISE EXCEPTION 'Owner session revoked before the host audit event was written';
      END IF;
      RETURN OLD;
    END;
    $$;
    CREATE TRIGGER require_recovery_audit
      BEFORE DELETE ON auth_sessions
      FOR EACH ROW EXECUTE FUNCTION require_recovery_audit_before_session_revocation();
  `);

  const entrypoint = fileURLToPath(new URL("./recover-owner.ts", import.meta.url));
  const { stderr, stdout } = await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--conditions=swizzle-source",
    entrypoint,
    email,
  ]);
  expect(stderr).toBe("");
  expect(stdout).toContain(`reset-link: ${DASHBOARD_ORIGIN}/`);
  expect((await browser.send("GET", "/auth/status")).json()).toMatchObject({
    authenticated: false,
  });
  const events = await testAuditStore(database).list({
    environments: null,
    limit: 10,
    projectIds: null,
  });
  expect(events.find((event) => event.action === "recover-owner")).toMatchObject({
    actor: { kind: "host" },
    params: { email },
    status: 200,
  });
});

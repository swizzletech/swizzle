// Migrates this worktree's dev database and seeds it: the test account, a member with the same
// password and no grants, the local worker, and the webhook examples deployed to staging, the environment the dashboard shows. scripts/dev-stack.mts runs it before the
// services start, with the stack's environment: the databases, the artifact directory and the login.
// Every step converges, so a rerun on a seeded database changes nothing a user sees.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseClient,
  createPostgresSwizzleAuth,
  hashPassword,
  provisionLocalWorker,
} from "@swizzle/db/postgres";
import { createPlatformServices } from "@swizzle/runtime/platform";

// Webhook triggers only: a cron example would add runs on its own schedule, so two seeds would differ.
const EXAMPLES = ["hello-webhook", "document-scanner", "webhook-transformer", "typescript-webhook"];

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

async function main(): Promise<void> {
  const email = process.env.SWIZZLE_DEV_OWNER_EMAIL;
  const password = process.env.SWIZZLE_DEV_OWNER_PASSWORD;
  const memberEmail = process.env.SWIZZLE_DEV_MEMBER_EMAIL;
  if (!email || !password || !memberEmail)
    throw new Error("Run this through scripts/dev-stack.mts, which sets the login.");

  const client = createDatabaseClient();
  try {
    await client.migrate();
    const auth = createPostgresSwizzleAuth({
      client,
      links: null,
      effects: { grantProject: async () => undefined, revokeTokens: async () => undefined },
      secureCookies: false,
      setupToken: null,
      trustedOrigins: [],
    });
    if (await auth.setupRequired()) {
      const created = await auth.handle("/sign-up/email", {
        body: { email, name: "Test Person", password },
        headers: new Headers(),
      });
      if (!created.ok) throw new Error(`The test account was not created: ${created.message}`);
    }
    // Sign-up after the first account needs an invitation, so the seed inserts the member directly.
    await client.pool.query(
      `WITH person AS (
         INSERT INTO auth_users (name, email) VALUES ('Member Person', $1)
         ON CONFLICT (email) DO NOTHING RETURNING id)
       INSERT INTO auth_accounts (user_id, account_id, provider_id, password)
       SELECT id, id::text, 'credential', $2 FROM person`,
      [memberEmail, await hashPassword(password)],
    );
  } finally {
    await client.close();
  }

  // The API provisions the same identity at boot; the examples' deploys need it registered first.
  const token = process.env.SWIZZLE_LOCAL_WORKER_TOKEN;
  if (!token)
    throw new Error("Run this through scripts/dev-stack.mts, which sets the local worker.");
  await provisionLocalWorker({ token, capacity: 2 });

  const platform = await createPlatformServices();
  try {
    for (const example of EXAMPLES) {
      const automationDirectory = path.join(repoRoot, "infra/examples", example);
      // An unchanged source is a no-op deploy, so a rerun adds no deployment.
      await platform.deployAutomationToPlatform({ automationDirectory, environment: "staging" });
    }
  } finally {
    await platform.close();
  }
}

await main();

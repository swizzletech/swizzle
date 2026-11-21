import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseClient,
  createPostgresSwizzleAuth,
  hashPassword,
  provisionLocalWorker,
} from "@swizzle/db/postgres";
import { createPlatformServices } from "@swizzle/runtime/platform";

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

  const token = process.env.SWIZZLE_LOCAL_WORKER_TOKEN;
  if (!token)
    throw new Error("Run this through scripts/dev-stack.mts, which sets the local worker.");
  await provisionLocalWorker({ token, capacity: 2 });

  const platform = await createPlatformServices();
  try {
    for (const example of EXAMPLES) {
      const automationDirectory = path.join(repoRoot, "infra/examples", example);
      await platform.deployAutomationToPlatform({ automationDirectory, environment: "staging" });
    }
  } finally {
    await platform.close();
  }
}

await main();

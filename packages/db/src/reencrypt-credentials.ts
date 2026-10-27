import { createDatabaseClient } from "./client.js";
import { reencryptStoredCredentials } from "./credential-reencryption.js";
import { assertSecretEncryptionKeyIsConfigured } from "./secrets.js";

async function main(): Promise<void> {
  assertSecretEncryptionKeyIsConfigured();
  const client = createDatabaseClient();
  try {
    const result = await reencryptStoredCredentials(client.db);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});

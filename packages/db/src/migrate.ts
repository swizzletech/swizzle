import { createDatabaseClient } from "./client.js";

async function main() {
  const client = createDatabaseClient();

  try {
    await client.migrate();
    process.stdout.write("Database migrations applied.\n");
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

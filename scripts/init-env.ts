// Writes .env from .env.example with fresh local credentials and a compose project of its own.
// `just init-env` runs it, and `just setup` and `just stack` run that recipe first; an existing .env
// keeps its values and must have every required credential (scripts/env-file.ts).

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ensureEnvFile, packagedStackValues } from "./env-file.ts";

const project = `swizzle-${randomBytes(4).toString("hex")}`;
const result = await ensureEnvFile(
  ".env",
  await readFile(".env.example", "utf8"),
  packagedStackValues(project),
);
if (result.created) {
  process.stdout.write(
    "Created .env with unique local credentials (mode 0600). Keep it out of version control.\n" +
      "Use SWIZZLE_SETUP_TOKEN from .env when the owner setup screen asks for it.\n",
  );
} else {
  process.stdout.write("Kept the existing .env and its credentials.\n");
}

// Writes .env from .env.example with fresh local credentials and a compose project of its own.
// `just init-env` runs it, and `just setup` and `just stack` run that recipe first; an existing .env
// keeps its settings except the obsolete image tag, and must have every required credential.
// It also sizes the CPU limits to the Docker engine and fails when an explicit one exceeds it, so
// `just stack` stops before it builds an image Compose could not start.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  dockerCpus,
  ensureEnvFile,
  packagedStackValues,
  removeImageTag,
  sizeCpuLimits,
} from "./env-file.ts";

// Every failure is an operator's fix to .env or Docker, so it prints its message without a stack.
try {
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
  if (await removeImageTag(".env")) {
    process.stdout.write(
      "Removed obsolete SWIZZLE_IMAGE_TAG; the API reports the running code version.\n",
    );
  }
  const hostCpus = dockerCpus();
  const sized = await sizeCpuLimits(".env", hostCpus);
  if (!result.created && sized.length > 0) {
    process.stdout.write(
      `Sized ${sized.join(" and ")} in .env to this ${hostCpus}-CPU Docker host.\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

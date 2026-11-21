import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  dockerCpus,
  ensureEnvFile,
  packagedStackValues,
  removeImageTag,
  sizeCpuLimits,
} from "./env-file.ts";

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

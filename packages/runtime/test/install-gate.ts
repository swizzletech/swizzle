import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A real npm install that emits a join marker and waits for the test to release it. */
export async function createInstallGate(directory: string, stack: string) {
  const name = `swizzle-install-gate-${randomUUID()}`;
  const baseImage = `swizzle-install-gate:${randomUUID()}`;
  const script = path.join(directory, "gated-npm");
  await writeFile(
    script,
    `#!/bin/sh
printf 'install waiting\\n'
while [ ! -e /tmp/release-install ]; do sleep 0.05; done
printf 'Installation continues with enough output to exceed the individual preparation log allowance.\\n'
exec node /usr/local/lib/node_modules/npm/bin/npm-cli.js "$@"
`,
    { mode: 0o755 },
  );
  try {
    await exec("docker", [
      "create",
      "--name",
      name,
      "--entrypoint",
      "/bin/sh",
      "node:26.12.1-trixie-slim",
      "-c",
      "rm /usr/local/bin/npm",
    ]);
    await exec("docker", ["start", "--attach", name]);
    await exec("docker", ["cp", script, `${name}:/usr/local/bin/npm`]);
    await exec("docker", ["commit", name, baseImage]);
  } finally {
    await exec("docker", ["rm", "--force", name]);
  }
  return {
    baseImage,
    async release() {
      const listed = await exec("docker", [
        "ps",
        "--quiet",
        "--filter",
        `label=swizzle.stack=${stack}`,
        "--filter",
        "name=swizzle-image-",
      ]);
      const containers = listed.stdout.trim().split("\n").filter(Boolean);
      if (containers.length !== 1)
        throw new Error(`Expected one gated assembly, found ${containers.length}.`);
      await exec("docker", ["exec", containers[0] ?? "", "touch", "/tmp/release-install"]);
    },
    async close() {
      await exec("docker", ["image", "rm", "--force", baseImage]);
    },
  };
}

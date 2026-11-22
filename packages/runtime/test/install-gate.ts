import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inject } from "vitest";
import { waitFor } from "../../../test/support.js";
import { FALLBACK_BASE_IMAGES } from "../src/run-image.js";

const exec = promisify(execFile);

export async function createInstallGate(directory: string, stack: string) {
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
  await writeFile(
    path.join(directory, "Dockerfile"),
    [
      `FROM ${FALLBACK_BASE_IMAGES.node}`,
      "RUN rm /usr/local/bin/npm",
      "COPY gated-npm /usr/local/bin/npm",
      "",
    ].join("\n"),
  );
  return {
    baseImage,
    async build(signal: AbortSignal) {
      await exec(
        "docker",
        ["build", "--label", inject("dockerRun").label, "--tag", baseImage, directory],
        { signal },
      );
    },
    async release(signal: AbortSignal) {
      await waitFor(signal, async () => {
        const listed = await exec(
          "docker",
          [
            "ps",
            "--quiet",
            "--filter",
            `label=swizzle.stack=${stack}`,
            "--filter",
            "name=swizzle-image-",
          ],
          { signal },
        );
        const [container, ...others] = listed.stdout.trim().split("\n").filter(Boolean);
        if (others.length > 0)
          throw new Error(`Expected one gated assembly, found ${others.length + 1}.`);
        if (container === undefined) return false;
        await exec("docker", ["exec", container, "touch", "/tmp/release-install"], { signal });
        return true;
      });
    },
    async close(signal: AbortSignal) {
      try {
        await exec("docker", ["image", "rm", "--no-prune", baseImage], { signal });
      } catch (error) {
        if (!(error instanceof Error && error.message.includes(`No such image: ${baseImage}`)))
          throw error;
      }
    },
  };
}

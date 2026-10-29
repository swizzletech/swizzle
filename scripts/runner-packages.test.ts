import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { prepareImages } from "./stack-images.ts";

it.each(["--allow-unauthenticated", "jq;id", "jq=1.0", "jq\tcurl", "curl*", "jq:amd64"])(
  "refuses invalid runner package %s before preparing any image",
  async (entry) => {
    const directory = await temporaryDirectory("swizzle-invalid-runner-packages-");
    const envFile = path.join(directory, ".env");
    await writeFile(envFile, "");
    const config = path.join(directory, "compose.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "swizzle-invalid-runner-packages",
        services: {
          "runner-base": {
            build: {
              context: directory,
              dockerfile: "Dockerfile",
              target: "runner-base",
              args: { SWIZZLE_RUNNER_APT_PACKAGES: entry },
            },
          },
        },
      }),
    );
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$1" >> '${directory}/calls'
if [ "$1" = compose ]; then cat '${config}'; exit; fi
echo 'unexpected image preparation' >&2
exit 1
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);

    expect(() =>
      prepareImages({ root: directory, envFile }, path.join(directory, "prepared.json")),
    ).toThrow(`Invalid SWIZZLE_RUNNER_APT_PACKAGES entry ${JSON.stringify(entry)}`);
    expect(await readFile(path.join(directory, "calls"), "utf8")).toBe("compose\n");
  },
);

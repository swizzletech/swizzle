import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { create as tarCreate } from "tar";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { DockerScope } from "./docker-cli.js";
import { readImageLayerHistory } from "./docker-image-history.js";

it("reports a tar parse error when a truncated Docker export exits normally", async () => {
  const directory = await temporaryDirectory("swizzle-truncated-image-export-");
  const id = "a".repeat(64);
  const config = `${id}.json`;
  await writeFile(
    path.join(directory, config),
    JSON.stringify({ rootfs: { diff_ids: ["base"] }, history: [{}] }),
  );
  const archive = path.join(directory, "image.tar");
  await tarCreate({ cwd: directory, file: archive }, [config]);
  // Keep the valid header and cut the config body short. Docker still exits with code 0.
  await writeFile(archive, (await readFile(archive)).subarray(0, 520));
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(archive)}));
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  const owner = new DockerScope({ timeoutMs: 5_000, containerName: null });
  try {
    await expect(
      readImageLayerHistory([{ id: `sha256:${id}`, layers: ["base"] }], owner),
    ).rejects.toThrow(/TAR_BAD_ARCHIVE: Truncated input/u);
  } finally {
    await owner.close();
  }
});

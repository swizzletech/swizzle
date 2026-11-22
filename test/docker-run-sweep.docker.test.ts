import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, inject, it } from "vitest";
import { removeContainersWithLabel, removeImagesWithLabel } from "./docker-images.js";
import { temporaryDirectory } from "./support.js";

const execute = promisify(execFile);
const probe = process.env.SWIZZLE_DOCKER_SWEEP_PROBE;

if (probe !== undefined) {
  it("leaves Docker fixtures when interrupted", async ({ signal }) => {
    const directory = await temporaryDirectory("swizzle-docker-sweep-");
    const archive = path.join(directory, "rootfs.tar");
    const label = `swizzle.test.probe=${probe}`;
    const image = `swizzle-docker-sweep:${probe}`;
    await writeFile(archive, Buffer.alloc(1024));
    await execute(
      "docker",
      [
        "image",
        "import",
        "--change",
        `LABEL ${label}`,
        "--change",
        `LABEL ${inject("dockerRun").label}`,
        archive,
        image,
      ],
      { signal },
    );
    await execute("docker", ["create", image, "/fixture"], { signal });
    throw new Error("Interrupted after creating the Docker fixtures");
  });
} else {
  it("sweeps Docker fixtures left by a failed Vitest worker", async ({ signal }) => {
    const probe = randomUUID();
    const label = `swizzle.test.probe=${probe}`;
    const vitest = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));
    const filters = ["--all", "--quiet", "--filter", `label=${label}`];
    const list = async (kind: "container" | "image") =>
      (await execute("docker", [kind, "ls", ...filters])).stdout.trim().split("\n").filter(Boolean);

    try {
      await expect(
        execute(
          process.execPath,
          [vitest, "run", "--project", "docker", fileURLToPath(import.meta.url)],
          {
            env: { ...process.env, SWIZZLE_DOCKER_SWEEP_PROBE: probe },
            signal,
          },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Interrupted after creating the Docker fixtures"),
      });
      expect({ containers: await list("container"), images: await list("image") }).toEqual({
        containers: [],
        images: [],
      });
    } finally {
      await removeContainersWithLabel(label);
      await removeImagesWithLabel(label);
    }
  });
}

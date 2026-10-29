import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { heldDeadlines, temporaryDirectory } from "../../../test/support.js";
import { inspectRunnerImage } from "./runner-image-inspection.js";

it("reads the selected image's inventory without starting its entrypoint", async ({ signal }) => {
  heldDeadlines();
  const directory = await temporaryDirectory("swizzle-image-record-");
  const image = `swizzle-image-record:${randomUUID()}`;
  const exec = promisify(execFile);
  await writeFile(
    path.join(directory, "runner-tools.json"),
    JSON.stringify({
      languages: [
        { name: "node", version: "26.12.1" },
        { name: "typescript", version: "26.12.1" },
      ],
      dependencyPackaging: { node: false, python: false },
      binaries: [
        { name: "image-only", version: "7.2" },
        { name: "node", version: "26.12.1" },
      ],
    }),
  );
  // The image need not even contain a runnable entrypoint to have a readable build record.
  await writeFile(
    path.join(directory, "Dockerfile"),
    'FROM scratch\nCOPY runner-tools.json /etc/swizzle/runner-tools.json\nENTRYPOINT ["/never-execute"]\n',
  );
  await exec("docker", ["build", "--tag", image, directory], { signal });
  try {
    expect(await inspectRunnerImage({ id: "record-probe", image })).toMatchObject({
      id: "record-probe",
      result: {
        kind: "ready",
        capabilities: {
          binaries: [
            { name: "image-only", version: "7.2" },
            { name: "node", version: "26.12.1" },
          ],
          languages: [
            { name: "node", version: "26.12.1" },
            { name: "typescript", version: "26.12.1" },
          ],
          dependencyPackaging: { node: false, python: false },
        },
      },
    });
  } finally {
    await exec("docker", ["image", "rm", image]);
  }
});

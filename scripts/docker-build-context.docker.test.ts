import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const execute = promisify(execFile);

it("keeps task notes out of the Docker build context", async ({ signal }) => {
  const directory = await temporaryDirectory("swizzle-build-context-");
  const context = path.join(directory, "context");
  const exported = path.join(directory, "exported");
  await mkdir(context);
  await copyFile(new URL("../.dockerignore", import.meta.url), path.join(context, ".dockerignore"));
  await writeFile(path.join(context, "Dockerfile"), "FROM scratch\nCOPY . /\n");
  await writeFile(path.join(context, "NOTES.md"), "Task notes\n");
  await writeFile(path.join(context, "package.json"), '{"name":"context-probe"}');

  await execute("docker", ["buildx", "build", "--output", `type=local,dest=${exported}`, context], {
    signal,
  });

  expect(await readFile(path.join(exported, "package.json"), "utf8")).toBe(
    '{"name":"context-probe"}',
  );
  await expect(readFile(path.join(exported, "NOTES.md"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

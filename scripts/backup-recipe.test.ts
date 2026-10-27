import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const execute = promisify(execFile);
const justfile = fileURLToPath(new URL("../justfile", import.meta.url));

// Every file below a directory with its mode and contents, and every directory with its mode.
async function snapshot(directory: string) {
  const entries: Record<string, string> = {};
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    const info = await stat(path.join(directory, name));
    const mode = (info.mode & 0o777).toString(8);
    entries[name] = info.isFile()
      ? `${mode} ${await readFile(path.join(directory, name), "utf8")}`
      : mode;
  }
  return entries;
}

it.each(["complete", "truncated", "existing destination"])(
  "publishes only a complete backup into a new directory (%s)",
  async (scenario) => {
    const root = await temporaryDirectory("swizzle-backup-recipe-");
    const source = path.join(root, "source");
    // A space in the directory must survive into the printed restore command.
    const output = path.join(root, "daily backup");
    const bin = path.join(root, "bin");
    const dockerLog = path.join(root, "docker.log");
    const backup = {
      "database.sql": "new dump".repeat(1000),
      "metadata.json": JSON.stringify({
        artifactBackend: "local",
        createdAt: "2026-10-24T00:00:00.000Z",
        formatVersion: 1,
      }),
      "artifacts/main.js": "new code",
    };
    await mkdir(path.join(source, "artifacts"), { recursive: true });
    await mkdir(bin);
    for (const [name, contents] of Object.entries(backup))
      await writeFile(path.join(source, name), contents, { mode: 0o644 });
    const archive = path.join(root, "backup.tar");
    await execute("tar", [
      "-cf",
      archive,
      "-C",
      source,
      "database.sql",
      "artifacts",
      "metadata.json",
    ]);
    if (scenario === "truncated")
      await writeFile(archive, (await readFile(archive)).subarray(0, 700));
    if (scenario === "existing destination") {
      await mkdir(output);
      await writeFile(path.join(output, "metadata.json"), "previous backup");
    }
    await writeFile(
      path.join(bin, "docker"),
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.includes("run")) process.stdout.write(fs.readFileSync(${JSON.stringify(archive)}));
`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);

    const result = execute("just", ["--justfile", justfile, "backup", output]);
    if (scenario === "complete") {
      // The export inside the container names its own path, which the host cannot restore from.
      expect((await result).stdout).toBe(
        `Backup written to ${output}. Run \`just restore '${output}'\` to restore it.\n`,
      );
      expect(await snapshot(output)).toEqual({
        artifacts: "700",
        "artifacts/main.js": "600 new code",
        "database.sql": `600 ${backup["database.sql"]}`,
        "metadata.json": `600 ${backup["metadata.json"]}`,
      });
      expect((await stat(output)).mode & 0o777).toBe(0o700);
    }
    if (scenario === "truncated") {
      await expect(result).rejects.toMatchObject({ stderr: expect.stringContaining("tar:") });
      expect(await readdir(root)).not.toContain("daily backup");
    }
    if (scenario === "existing destination") {
      await expect(result).rejects.toMatchObject({
        stderr: expect.stringContaining("Choose a new directory, for example one named by date"),
      });
      expect(await readFile(dockerLog, "utf8").catch(() => "")).toBe("");
      expect(await snapshot(output)).toEqual({ "metadata.json": "644 previous backup" });
    }
    expect((await readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
  },
);

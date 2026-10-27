import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { createBufferIO, useCliTestEnvironment } from "../test/cli-harness.js";
import { runCli } from "./main.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: vi.fn(actual.cp),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
  };
});

useCliTestEnvironment();
beforeEach(() => {
  vi.mocked(cp).mockReset();
  vi.mocked(open).mockReset();
  vi.mocked(rename).mockReset();
});

// A fixture instance: a local artifact store and a pg_dump that writes $BACKUP_TEST_DUMP and
// logs each call, so a test can see whether the export reached the database.
async function exportFixture() {
  const root = await temporaryDirectory("swizzle-backup-");
  const output = path.join(root, "backup");
  const artifacts = path.join(root, "source");
  const bin = path.join(root, "bin");
  const dumpLog = path.join(root, "pg_dump.log");
  await mkdir(path.join(artifacts, "deployment"), { recursive: true });
  await mkdir(bin);
  await writeFile(path.join(artifacts, "deployment/main.js"), "source code\n", { mode: 0o755 });
  await writeFile(
    path.join(bin, "pg_dump"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(dumpLog)}, "called\\n");
fs.writeFileSync(process.argv[process.argv.indexOf("--file") + 1], process.env.BACKUP_TEST_DUMP);
if (process.env.BACKUP_TEST_DUMP_FAILS) process.exit(1);
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", bin);
  vi.stubEnv("DATABASE_URL", "postgresql://fixture");
  vi.stubEnv("SWIZZLE_ARTIFACT_BACKEND", "local");
  vi.stubEnv("SWIZZLE_ARTIFACTS_DIR", artifacts);
  vi.stubEnv("BACKUP_TEST_DUMP", "sensitive database dump\n");
  const dumpCalls = async () =>
    (await readFile(dumpLog, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { root, output, artifacts, bin, dumpCalls };
}

async function exportBackup(output: string) {
  const io = createBufferIO();
  const exitCode = await runCli(["backup", "export", "--output-dir", output, "--json"], io);
  return { exitCode, envelope: JSON.parse(io.stdoutText) };
}

// Every path below a directory with its mode and, for files, its contents.
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

describe.skipIf(process.platform === "win32")("backup export", () => {
  it.each(["new", "empty"])(
    "writes one owner-only backup into a %s directory that restore reads back",
    async (destination) => {
      const { root, output, bin } = await exportFixture();
      if (destination === "empty") await mkdir(output, { mode: 0o755 });
      expect((await exportBackup(output)).exitCode).toBe(0);
      expect(await snapshot(output)).toEqual({
        artifacts: "700",
        "artifacts/deployment": "700",
        "artifacts/deployment/main.js": "600 source code\n",
        "database.sql": "600 sensitive database dump\n",
        "metadata.json": expect.stringMatching(/^600 \{\n {2}"artifactBackend": "local"/u),
      });
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      expect(await readdir(root)).toEqual(["backup", "bin", "pg_dump.log", "source"]);

      const restoredArtifacts = path.join(root, "restored");
      const psqlInput = path.join(root, "psql-input.sql");
      await writeFile(
        path.join(bin, "psql"),
        `#!${process.execPath}
const fs = require("node:fs");
fs.copyFileSync(process.argv[process.argv.indexOf("--file") + 1], ${JSON.stringify(psqlInput)});
`,
        { mode: 0o755 },
      );
      vi.stubEnv("SWIZZLE_ARTIFACTS_DIR", restoredArtifacts);
      const io = createBufferIO();
      expect(
        await runCli(["backup", "restore", "--input-dir", output, "--yes", "--json"], io),
        io.stdoutText,
      ).toBe(0);
      expect(await readFile(psqlInput, "utf8")).toBe("sensitive database dump\n");
      expect(await readFile(path.join(restoredArtifacts, "deployment/main.js"), "utf8")).toBe(
        "source code\n",
      );
    },
  );

  it.each(["a backup", "a file", "a symbolic link"])(
    "refuses a destination that holds %s before it dumps, and leaves it unchanged",
    async (content) => {
      const { root, output, dumpCalls } = await exportFixture();
      if (content === "a backup") expect((await exportBackup(output)).exitCode).toBe(0);
      if (content === "a file") {
        await mkdir(output);
        await writeFile(path.join(output, "notes.txt"), "keep me\n", { mode: 0o644 });
      }
      if (content === "a symbolic link") {
        await mkdir(path.join(root, "elsewhere"));
        await symlink(path.join(root, "elsewhere"), output);
      }
      const before = await snapshot(output);
      const callsBefore = await dumpCalls();

      const { exitCode, envelope } = await exportBackup(output);
      expect(exitCode).toBe(8);
      expect(envelope).toMatchObject({
        code: "BACKUP_DESTINATION_EXISTS",
        help: [expect.stringContaining("Choose a new directory, for example one named by date")],
      });
      expect(await dumpCalls()).toBe(callsBefore);
      expect(await snapshot(output)).toEqual(before);
      expect((await readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
    },
  );

  it("flushes every staged file and directory before the rename and the parent after it", async () => {
    const { root, output } = await exportFixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const label = (target: unknown) =>
      path.relative(root, String(target)).replace(/^\.backup-[^/]+/u, "<staging>") || "<root>";
    const events: string[] = [];
    vi.mocked(open).mockImplementation(async (target, flags, mode) => {
      const handle = await actual.open(target, flags, mode);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        events.push(label(target));
      };
      return handle;
    });
    vi.mocked(rename).mockImplementation(async (source, target) => {
      await actual.rename(source, target);
      events.push(`rename ${label(source)} -> ${label(target)}`);
    });
    expect((await exportBackup(output)).exitCode).toBe(0);

    const flushed = events.slice(0, -2);
    expect(events.slice(-2)).toEqual(["rename <staging> -> backup", "<root>"]);
    expect([...flushed].sort()).toEqual([
      "<staging>",
      "<staging>/artifacts",
      "<staging>/artifacts/deployment",
      "<staging>/artifacts/deployment/main.js",
      "<staging>/database.sql",
      "<staging>/metadata.json",
    ]);
    // A directory is flushed after every entry it names.
    for (const directory of flushed)
      for (const entry of flushed.filter((name) => name.startsWith(`${directory}/`)))
        expect(flushed.indexOf(entry), `${entry} before ${directory}`).toBeLessThan(
          flushed.indexOf(directory),
        );
  });

  it("refuses a destination that gains content while it exports", async () => {
    const { root, output } = await exportFixture();
    // pg_dump runs after the destination check; another writer takes the directory meanwhile.
    await writeFile(
      path.join(root, "bin/pg_dump"),
      `#!${process.execPath}
const fs = require("node:fs");
fs.mkdirSync(${JSON.stringify(output)});
fs.writeFileSync(${JSON.stringify(path.join(output, "other.txt"))}, "other writer\\n");
fs.writeFileSync(process.argv[process.argv.indexOf("--file") + 1], "dump");
`,
      { mode: 0o755 },
    );
    const { exitCode, envelope } = await exportBackup(output);
    expect(exitCode).toBe(8);
    expect(envelope.code).toBe("BACKUP_DESTINATION_EXISTS");
    expect(await readdir(output)).toEqual(["other.txt"]);
    expect((await readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  it.each([
    ["missing database URL", 2],
    ["failed dump", 1],
    ["failed artifact copy", 1],
  ])("leaves no destination after a %s", async (failure, exit) => {
    const { root, output } = await exportFixture();
    if (failure === "missing database URL") vi.stubEnv("DATABASE_URL", undefined);
    if (failure === "failed dump") vi.stubEnv("BACKUP_TEST_DUMP_FAILS", "1");
    if (failure === "failed artifact copy")
      vi.mocked(cp).mockRejectedValueOnce(
        Object.assign(new Error("EACCES: artifact copy denied"), { code: "EACCES" }),
      );
    expect((await exportBackup(output)).exitCode).toBe(exit);
    expect(await readdir(root)).not.toContain("backup");
    expect((await readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
  });
});

describe("backup restore", () => {
  it("quotes the backup directory in the command that confirms it", async () => {
    const directory = path.join(await temporaryDirectory("swizzle-backup-"), "daily backup");
    const io = createBufferIO();

    expect(await runCli(["backup", "restore", "-i", directory, "--json"], io)).toBe(2);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      help: [`Run \`swizzle backup restore -i '${directory}' --yes\``],
    });
  });
});

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { list as tarList } from "tar";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import {
  BundleEmptyError,
  BundleTooLargeError,
  collectBundleFiles,
  packAutomation,
} from "./bundle.js";

async function createTempFixture(): Promise<string> {
  const dir = await temporaryDirectory("swizzle-bundle-test-");
  return dir;
}

async function listTarEntries(bundle: Buffer): Promise<string[]> {
  const entries: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const parser = tarList({ onentry: (entry) => entries.push(entry.path) });
    Readable.from([bundle])
      .pipe(createGunzip())
      .pipe(parser)
      .on("finish", resolve)
      .on("error", reject);
  });
  return entries.toSorted();
}

describe("collectBundleFiles", () => {
  it("collects files and ignores standard directories", async () => {
    const dir = await createTempFixture();
    await writeFile(path.join(dir, "config.yaml"), "name: demo\n");
    await writeFile(path.join(dir, "main.ts"), "console.log('hi');\n");
    await mkdir(path.join(dir, "node_modules", "foo"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "foo", "index.js"), "// ignore me");
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(path.join(dir, ".DS_Store"), "junk");

    const files = await collectBundleFiles(dir);
    expect(files.toSorted()).toEqual(["config.yaml", "main.ts"]);
  });
});

describe("packAutomation", () => {
  it("produces a deterministic content hash for identical inputs", async () => {
    const dirA = await createTempFixture();
    const dirB = await createTempFixture();
    for (const dir of [dirA, dirB]) {
      await writeFile(path.join(dir, "config.yaml"), "name: demo\nversion: 1.0.0\n");
      await writeFile(path.join(dir, "main.ts"), "export const hello = 'world';\n");
    }

    const packedA = await packAutomation(dirA);
    const packedB = await packAutomation(dirB);
    expect(packedA.contentHash).toEqual(packedB.contentHash);
  });

  it("differs when content changes", async () => {
    const dir = await createTempFixture();
    await writeFile(path.join(dir, "config.yaml"), "name: demo\nversion: 1.0.0\n");
    await writeFile(path.join(dir, "main.ts"), "v1");
    const packedV1 = await packAutomation(dir);

    await writeFile(path.join(dir, "main.ts"), "v2");
    const packedV2 = await packAutomation(dir);

    expect(packedV1.contentHash).not.toEqual(packedV2.contentHash);
  });

  it("keeps the source hash stable when only config.yaml changes", async () => {
    const dir = await createTempFixture();
    await writeFile(path.join(dir, "config.yaml"), "name: demo\nversion: 1.0.0\n");
    await writeFile(path.join(dir, "main.ts"), "v1");
    const packedV1 = await packAutomation(dir);

    await writeFile(path.join(dir, "config.yaml"), "name: demo\nversion: 1.0.1\n");
    const packedV2 = await packAutomation(dir);

    expect(packedV1.contentHash).toEqual(packedV2.contentHash);
    expect(packedV2.includedFiles).toContain("config.yaml");
  });

  it("throws BundleEmptyError when no files match", async () => {
    const dir = await createTempFixture();
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "x.js"), "ignored");

    await expect(packAutomation(dir)).rejects.toBeInstanceOf(BundleEmptyError);
  });

  it("throws BundleTooLargeError when limit is exceeded", async () => {
    const dir = await createTempFixture();
    // 2 MB of low-entropy data compresses well, so we set a tiny limit to force the error.
    const payload = "A".repeat(2 * 1024 * 1024);
    await writeFile(path.join(dir, "config.yaml"), "name: demo\n");
    await writeFile(path.join(dir, "big.txt"), payload);

    await expect(packAutomation(dir, { maxBundleBytes: 1024 })).rejects.toBeInstanceOf(
      BundleTooLargeError,
    );
  });

  it("packs nested files under posix paths", async () => {
    const dir = await createTempFixture();
    await mkdir(path.join(dir, "subdir"), { recursive: true });
    await writeFile(path.join(dir, "config.yaml"), "name: demo\n");
    await writeFile(path.join(dir, "main.ts"), "console.log('hi');\n");
    await writeFile(path.join(dir, "subdir", "helper.ts"), "export const x = 1;\n");

    const packed = await packAutomation(dir);
    const entries = await listTarEntries(packed.bundle);
    expect(entries).toEqual(["config.yaml", "main.ts", "subdir/helper.ts"]);
  });
});

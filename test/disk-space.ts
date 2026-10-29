import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { onTestFinished, vi } from "vitest";

/** Own the statfs measurement in this process and in recipe children. */
export function diskSpace(gib: number): void {
  const bytes = gib * 1024 ** 3;
  const measurement = vi.spyOn(fs, "statfsSync").mockReturnValue({
    ...fs.statfsSync(process.cwd()),
    bsize: 1,
    bavail: bytes,
  });
  syncBuiltinESMExports();
  onTestFinished(() => {
    measurement.mockRestore();
    syncBuiltinESMExports();
  });
  vi.stubEnv("SWIZZLE_TEST_FREE_BYTES", String(bytes));
  const preload = fileURLToPath(new URL("fixtures/disk-space.mjs", import.meta.url));
  vi.stubEnv(
    "NODE_OPTIONS",
    `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(preload)}`,
  );
}

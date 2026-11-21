import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { startVerificationApi } from "./verify-api-process.js";

it("reports a missing API executable without leaking a child", async () => {
  await expect(
    startVerificationApi({ ...process.env, PATH: "/nonexistent-swizzle-bin" }),
  ).rejects.toThrow("API process could not start");
});

it("returns the API address when the child reports readiness after a clock jump", async () => {
  const bin = await temporaryDirectory("swizzle-verify-api-");
  await writeFile(
    path.join(bin, "pnpm"),
    "#!/bin/sh\necho 'INFO (swizzle-api): Server listening at http://127.0.0.1:8123'\nexec /usr/bin/tail -f /dev/null\n",
    { mode: 0o700 },
  );
  const clock = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(21_000);
  try {
    const api = await startVerificationApi({ PATH: bin });
    try {
      expect(api.url).toBe("http://127.0.0.1:8123");
    } finally {
      await api.close();
    }
  } finally {
    clock.mockRestore();
  }
});

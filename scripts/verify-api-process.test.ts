import { expect, it } from "vitest";
import { startVerificationApi } from "./verify-api-process.js";

it("reports a missing API executable without leaking a child", async () => {
  await expect(
    startVerificationApi({ ...process.env, PATH: "/nonexistent-swizzle-bin" }),
  ).rejects.toThrow("API process could not start");
});

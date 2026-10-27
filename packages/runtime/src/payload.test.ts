import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { findSamplePayloadFile, loadPayload } from "./payload.js";

describe("payload helpers", () => {
  it("finds sample-payload.json only once it exists", async () => {
    const directory = await temporaryDirectory("swizzle-payload-");

    await expect(findSamplePayloadFile(directory)).resolves.toBeUndefined();
    await writeFile(path.join(directory, "sample-payload.json"), '{"hello":"world"}', "utf8");
    await expect(findSamplePayloadFile(directory)).resolves.toBe(
      path.join(directory, "sample-payload.json"),
    );
  });

  it("loads JSON payload files relative to the working directory", async () => {
    const directory = await temporaryDirectory("swizzle-payload-load-");

    await writeFile(path.join(directory, "payload.json"), '{"source":"working-dir"}', "utf8");

    await expect(
      loadPayload({
        filePath: "payload.json",
        workingDirectory: directory,
      }),
    ).resolves.toEqual({ source: "working-dir" });
  });
});

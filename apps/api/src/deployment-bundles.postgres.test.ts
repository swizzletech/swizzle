import { Header } from "tar";

import { beforeEach, describe, expect, it } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { ownerHeaders } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";

import { createBundleEntryFilter, MAX_BUNDLE_BYTES } from "./deployment-routes.js";

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

describe("deployment bundles", () => {
  it.each([
    ["FST_REQ_FILE_TOO_LARGE", 413, [{ file: true, value: Buffer.alloc(MAX_BUNDLE_BYTES + 1) }]],
    ["FST_FILES_LIMIT", 413, Array.from({ length: 2 }, () => ({ file: true, value: "bundle" }))],
    ["FST_FIELDS_LIMIT", 413, Array.from({ length: 17 }, () => ({ value: "field" }))],
  ] as const)("preserves %s and HTTP %i for rejected uploads", async (code, status, parts) => {
    const app = await buildTestServer();
    const boundary = "swizzle-limit-boundary";
    const payload = Buffer.concat([
      ...parts.flatMap((part) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="bundle"${"file" in part ? '; filename="bundle.tar"' : ""}\r\n\r\n`,
        ),
        Buffer.from(part.value),
        Buffer.from("\r\n"),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    try {
      const response = await app.inject({
        headers: { ...owner, "content-type": `multipart/form-data; boundary=${boundary}` },
        method: "POST",
        payload,
        url: "/deployments",
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code, error: code });
    } finally {
      await app.close();
    }
  });

  it("rejects traversal, links, and decompression bombs before writing them", () => {
    const refuse = (entryPath: string, entry: { size: number; type: string }) => {
      const rejected: string[] = [];
      const kept = createBundleEntryFilter((error) => rejected.push(error.message))(
        entryPath,
        entry,
      );
      return { kept, rejected };
    };

    expect(refuse("../escape", { size: 1, type: "File" })).toEqual({
      kept: false,
      rejected: ["Unsafe bundle path: ../escape"],
    });
    expect(refuse("config.yaml", { size: 1, type: "SymbolicLink" })).toEqual({
      kept: false,
      rejected: ["Unsupported bundle entry type SymbolicLink: config.yaml"],
    });
    expect(refuse("large.bin", { size: 50 * 1024 * 1024 + 1, type: "File" })).toEqual({
      kept: false,
      rejected: [`Expanded bundle exceeds ${50 * 1024 * 1024} bytes.`],
    });
  });

  it("answers DEPLOYMENT_BUNDLE_INVALID for a traversal entry instead of crashing", async () => {
    const app = await buildTestServer({ platform: await testPlatform() });
    const content = Buffer.from("bad");
    const header = new Header({
      mode: 0o644,
      path: "../escape",
      size: content.length,
      type: "File",
    });
    header.encode();
    const archive = Buffer.concat([
      header.block ?? Buffer.alloc(0),
      content,
      Buffer.alloc(512 - content.length),
      Buffer.alloc(1024),
    ]);
    const boundary = "swizzle-test-boundary";
    const response = await app.inject({
      headers: { ...owner, "content-type": `multipart/form-data; boundary=${boundary}` },
      method: "POST",
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="bundle"; filename="attack.tar"\r\n\r\n`,
        ),
        archive,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      url: "/deployments",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: "DEPLOYMENT_BUNDLE_INVALID" });

    await app.close();
  });
});

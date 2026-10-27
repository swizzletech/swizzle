import { writeFile } from "node:fs/promises";
import path from "node:path";

import { packAutomation } from "@swizzle/runtime";
import type { InjectOptions } from "fastify";

import { temporaryDirectory } from "../../../test/support.js";
import type { ApiServer } from "../src/http-shared.js";

/**
 * Deploy a fixture automation through the multipart /deployments endpoint, or with `dryRun` check
 * it through /deployment-checks, as `swizzle validate` does.
 */
export async function deployFixture(
  app: ApiServer,
  automationDirectory: string,
  {
    dryRun = false,
    ...meta
  }: {
    dryRun?: boolean;
    environment?: string;
    expectedContentHash?: string;
    force?: boolean;
    project?: string;
  } = {},
  injectOverrides: Partial<InjectOptions> = {},
) {
  const packed = await packAutomation(automationDirectory);
  const boundary = `----swizzle-test-${Math.random().toString(36).slice(2)}`;
  const metaWire = JSON.stringify({
    expectedContentHash: packed.contentHash,
    ...meta,
  });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="meta"\r\n\r\n`),
    Buffer.from(metaWire),
    Buffer.from(`\r\n--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="bundle"; filename="automation.tar.gz"\r\n`),
    Buffer.from(`Content-Type: application/gzip\r\n\r\n`),
    packed.bundle,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const overrideHeaders = injectOverrides.headers ?? {};

  return await app.inject({
    method: "POST",
    url: dryRun ? "/deployment-checks" : "/deployments",
    payload: body,
    ...injectOverrides,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...overrideHeaders,
    },
  });
}

/** A JavaScript webhook automation in its own directory, ready for deployFixture. */
export async function createAutomationFixture(input: {
  readonly mainJs: string;
  readonly name: string;
  readonly path: string;
  /** The platform secrets the automation declares. */
  readonly secrets?: readonly string[];
}): Promise<string> {
  const automationDirectory = await temporaryDirectory("swizzle-api-fixture-");
  await writeFile(
    path.join(automationDirectory, "config.yaml"),
    [
      `name: ${input.name}`,
      "version: 1.0.0",
      "entrypoint: main.js",
      "trigger:",
      "  type: webhook",
      `  path: ${input.path}`,
      ...(input.secrets === undefined
        ? []
        : [`secrets: [${input.secrets.join(", ")}]`, "api_check:", "  mode: passive"]),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(automationDirectory, "main.js"), input.mainJs, "utf8");
  return automationDirectory;
}

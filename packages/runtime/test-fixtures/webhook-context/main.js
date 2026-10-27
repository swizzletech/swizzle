#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const payload = JSON.parse(await readStdin());
const rawBodyPath = process.env.SWIZZLE_WEBHOOK_RAW_BODY_PATH;
const rawBody = rawBodyPath ? readFileSync(rawBodyPath) : Buffer.alloc(0);
const headers = JSON.parse(process.env.SWIZZLE_WEBHOOK_HEADERS ?? "{}");

process.stdout.write(
  JSON.stringify({
    headers,
    payload,
    raw_body: rawBody.toString("utf8"),
    raw_body_sha256: createHash("sha256").update(rawBody).digest("hex"),
    raw_body_sha256_env: process.env.SWIZZLE_WEBHOOK_RAW_BODY_SHA256 ?? null,
  }),
);

async function readStdin() {
  const chunks = [];
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

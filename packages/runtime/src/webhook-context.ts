import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AUTOMATION_WEBHOOK_HEADER_DENYLIST } from "@swizzle/config";

export interface WebhookRunContext {
  readonly headers: Record<string, string>;
  readonly rawBodyBase64: string;
  readonly rawBodyByteLength: number;
  readonly rawBodySha256: string;
}

export interface MaterializedWebhookRunContext {
  readonly environment: Record<string, string>;
  readonly mountDirectory: string;
  cleanup(): Promise<void>;
}

const WEBHOOK_HEADER_DENYLIST = AUTOMATION_WEBHOOK_HEADER_DENYLIST;

const DENIED_WEBHOOK_HEADERS: ReadonlySet<string> = new Set(WEBHOOK_HEADER_DENYLIST);

const WEBHOOK_HEADERS_ENV = "SWIZZLE_WEBHOOK_HEADERS";
const WEBHOOK_RAW_BODY_PATH_ENV = "SWIZZLE_WEBHOOK_RAW_BODY_PATH";
const WEBHOOK_RAW_BODY_SHA256_ENV = "SWIZZLE_WEBHOOK_RAW_BODY_SHA256";

export function createWebhookRunContext(input: {
  readonly headers: Record<string, string | readonly string[] | undefined>;
  readonly rawBody: Buffer;
}): WebhookRunContext {
  return {
    headers: selectWebhookHeaders(input.headers),
    rawBodyBase64: input.rawBody.toString("base64"),
    rawBodyByteLength: input.rawBody.byteLength,
    rawBodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
  };
}

export async function materializeWebhookRunContext(
  context: WebhookRunContext | null | undefined,
): Promise<MaterializedWebhookRunContext | null> {
  if (context === null || context === undefined) {
    return null;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "swizzle-webhook-"));
  const rawBodyPath = path.join(directory, "raw-body.bin");
  await writeFile(rawBodyPath, Buffer.from(context.rawBodyBase64, "base64"));

  return {
    cleanup: async () => {
      await rm(directory, { force: true, recursive: true });
    },
    environment: {
      [WEBHOOK_HEADERS_ENV]: JSON.stringify(context.headers),
      [WEBHOOK_RAW_BODY_PATH_ENV]: rawBodyPath,
      [WEBHOOK_RAW_BODY_SHA256_ENV]: context.rawBodySha256,
    },
    mountDirectory: directory,
  };
}

// Forwards the raw HTTP reality — every header except the platform's own credential
// channels. Which header matters is the automation's decision, exactly as it decides
// which payload field matters; the platform only guarantees that forwarding a webhook
// can never hand automation code a Swizzle credential. Total header size is bounded
// by the HTTP server's max-header limit, so this stays small enough to store per run.
function selectWebhookHeaders(
  headers: Record<string, string | readonly string[] | undefined>,
): Record<string, string> {
  const selected: Record<string, string> = {};

  for (const [rawName, value] of Object.entries(headers)) {
    const headerName = rawName.toLowerCase();
    if (value === undefined || DENIED_WEBHOOK_HEADERS.has(headerName)) {
      continue;
    }

    selected[headerName] = typeof value === "string" ? value : value.join(", ");
  }

  return selected;
}

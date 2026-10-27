// Public links that resolve one event wait of one run: the approval page (`/approvals/<token>`)
// and the event callback (`/events/<token>`). The platform stores no link. A deployed run
// receives a key of its own (`SWIZZLE_LINK_KEY`) and the public base (`SWIZZLE_LINK_URL`); the
// SDK signs `<kind> <step>` with that key, and the API recomputes the key from the run id to
// check the signature. Which wait a valid link may resolve, and until when, is decided in
// `findWaitByLink` (run-lifecycle.ts). docs/explanation/approvals.md explains why this is sound.

import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveSecretEncryptionKey, SecretConfigurationError } from "@swizzle/db";

/** What a link opens: the approval page of an approval wait, or the callback of an event wait. */
export type WaitLinkKind = "approval" | "event";

/** The wait a link names. The signature proved it; whether the run still waits there is open. */
export interface WaitLinkTarget {
  readonly runId: string;
  readonly stepKey: string;
}

export const SWIZZLE_LINK_URL_ENV = "SWIZZLE_LINK_URL";
export const SWIZZLE_LINK_KEY_ENV = "SWIZZLE_LINK_KEY";

// The longest encoded step key: 255 UTF-16 units (the suspend limit in run-lifecycle.ts) at up to
// 3 UTF-8 bytes each, in base64url.
const MAX_ENCODED_STEP_KEY_LENGTH = (255 * 3 * 4) / 3;
const RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BASE64URL = "[A-Za-z0-9_-]";

/**
 * The longest token a run can get: a UUID run id, the longest encoded step key and the signature.
 * The API router must accept a path parameter this long, or it answers 404 before the token is
 * checked.
 */
export const MAX_WAIT_LINK_TOKEN_LENGTH = 36 + 1 + MAX_ENCODED_STEP_KEY_LENGTH + 1 + 43;

const TOKEN = new RegExp(
  `${RUN_ID}\\.${BASE64URL}{1,${MAX_ENCODED_STEP_KEY_LENGTH}}\\.${BASE64URL}{43}`,
  "g",
);
const UNFINISHED_TOKEN = new RegExp(
  `(?:[0-9a-f-]{1,35}|${RUN_ID}(?:\\.${BASE64URL}{0,${MAX_ENCODED_STEP_KEY_LENGTH}}(?:\\.${BASE64URL}{0,42})?)?)$`,
);

/**
 * Where text shaped like a link token of any run occurs, as [start, end) ranges. The output
 * redactor hides each one, so whoever reads a run cannot take a decision from its output.
 */
export function findWaitLinkTokens(text: string): [number, number][] {
  return [...text.matchAll(TOKEN)].map((match) => [match.index, match.index + match[0].length]);
}

/** Where the end of `text` starts that more text could still complete into a link token. */
export function unfinishedWaitLinkTokenStart(text: string): number {
  const tail = text.slice(-MAX_WAIT_LINK_TOKEN_LENGTH);
  const match = UNFINISHED_TOKEN.exec(tail);
  return match === null ? text.length : text.length - tail.length + match.index;
}

const LINK_KEY_DERIVATION_CONTEXT = "swizzle-wait-link-v1";
const TOKEN_SEPARATOR = ".";

/**
 * The variables a deployed run receives to sign its own links, or none when the worker has no
 * `SWIZZLE_LINK_URL` or no valid encryption key.
 */
export function createRunLinkEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly runId: string;
}): Readonly<Record<string, string>> {
  const linkUrl = input.environment[SWIZZLE_LINK_URL_ENV]?.trim().replace(/\/+$/, "");
  if (linkUrl === undefined || linkUrl === "") return {};
  const runKey = tryDeriveRunLinkKey(input.environment, input.runId);
  if (runKey === null) return {};
  return { [SWIZZLE_LINK_KEY_ENV]: runKey, [SWIZZLE_LINK_URL_ENV]: linkUrl };
}

/** The link token for one wait, as the SDK builds it. Tests and the verify helper use it. */
export function createWaitLinkToken(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly kind: WaitLinkKind;
  readonly runId: string;
  readonly stepKey: string;
}): string {
  const runKey = deriveRunLinkKey(input.environment ?? process.env, input.runId);
  return [
    input.runId,
    Buffer.from(input.stepKey, "utf8").toString("base64url"),
    signWaitLink(runKey, input.kind, input.stepKey),
  ].join(TOKEN_SEPARATOR);
}

/** The wait a token names, or null for a malformed or forged token. */
export function verifyWaitLinkToken(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly kind: WaitLinkKind;
  readonly token: string;
}): WaitLinkTarget | null {
  const parts = input.token.split(TOKEN_SEPARATOR);
  if (parts.length !== 3) return null;
  const [runId = "", encodedStepKey = "", signature = ""] = parts;
  const stepKey = Buffer.from(encodedStepKey, "base64url").toString("utf8");
  // Only the canonical encoding of the step key is accepted, so one wait has exactly one token.
  if (
    runId === "" ||
    stepKey === "" ||
    Buffer.from(stepKey).toString("base64url") !== encodedStepKey
  ) {
    return null;
  }
  const runKey = tryDeriveRunLinkKey(input.environment ?? process.env, runId);
  if (runKey === null) return null;
  return timingSafeStringEqual(signature, signWaitLink(runKey, input.kind, stepKey))
    ? { runId, stepKey }
    : null;
}

// The SDKs sign with the key's text as HMAC key bytes, so they need no base64 decoding.
function signWaitLink(runKey: string, kind: WaitLinkKind, stepKey: string): string {
  return createHmac("sha256", runKey).update(`${kind}\n${stepKey}`, "utf8").digest("base64url");
}

function deriveRunLinkKey(environment: NodeJS.ProcessEnv, runId: string): string {
  const linkKey = createHmac("sha256", resolveSecretEncryptionKey(environment))
    .update(LINK_KEY_DERIVATION_CONTEXT, "utf8")
    .digest();
  return createHmac("sha256", linkKey).update(`run:${runId}`, "utf8").digest("base64url");
}

function tryDeriveRunLinkKey(environment: NodeJS.ProcessEnv, runId: string): string | null {
  try {
    return deriveRunLinkKey(environment, runId);
  } catch (error) {
    if (error instanceof SecretConfigurationError) return null;
    throw error;
  }
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

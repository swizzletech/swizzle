import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveSecretEncryptionKey, SecretConfigurationError } from "@swizzle/db";

export type WaitLinkKind = "approval" | "event";

export interface WaitLinkTarget {
  readonly runId: string;
  readonly stepKey: string;
}

export const SWIZZLE_LINK_URL_ENV = "SWIZZLE_LINK_URL";
export const SWIZZLE_LINK_KEY_ENV = "SWIZZLE_LINK_KEY";

const MAX_ENCODED_STEP_KEY_LENGTH = (255 * 3 * 4) / 3;
const RUN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BASE64URL = "[A-Za-z0-9_-]";

export const MAX_WAIT_LINK_TOKEN_LENGTH = 36 + 1 + MAX_ENCODED_STEP_KEY_LENGTH + 1 + 43;

const TOKEN = new RegExp(
  `${RUN_ID}\\.${BASE64URL}{1,${MAX_ENCODED_STEP_KEY_LENGTH}}\\.${BASE64URL}{43}`,
  "g",
);
const UNFINISHED_TOKEN = new RegExp(
  `(?:[0-9a-f-]{1,35}|${RUN_ID}(?:\\.${BASE64URL}{0,${MAX_ENCODED_STEP_KEY_LENGTH}}(?:\\.${BASE64URL}{0,42})?)?)$`,
);

export function findWaitLinkTokens(text: string): [number, number][] {
  return [...text.matchAll(TOKEN)].map((match) => [match.index, match.index + match[0].length]);
}

export function unfinishedWaitLinkTokenStart(text: string): number {
  const tail = text.slice(-MAX_WAIT_LINK_TOKEN_LENGTH);
  const match = UNFINISHED_TOKEN.exec(tail);
  return match === null ? text.length : text.length - tail.length + match.index;
}

const LINK_KEY_DERIVATION_CONTEXT = "swizzle-wait-link-v1";
const TOKEN_SEPARATOR = ".";

export function createRunLinkEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly runId: string;
}): Readonly<Record<string, string>> {
  const linkUrl = input.environment[SWIZZLE_LINK_URL_ENV]?.trim().replace(/(?<!\/)\/+$/u, "");
  if (linkUrl === undefined || linkUrl === "") return {};
  const runKey = tryDeriveRunLinkKey(input.environment, input.runId);
  if (runKey === null) return {};
  return { [SWIZZLE_LINK_KEY_ENV]: runKey, [SWIZZLE_LINK_URL_ENV]: linkUrl };
}

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

export function verifyWaitLinkToken(input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly kind: WaitLinkKind;
  readonly token: string;
}): WaitLinkTarget | null {
  const parts = input.token.split(TOKEN_SEPARATOR);
  if (parts.length !== 3) return null;
  const [runId = "", encodedStepKey = "", signature = ""] = parts;
  const stepKey = Buffer.from(encodedStepKey, "base64url").toString("utf8");
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

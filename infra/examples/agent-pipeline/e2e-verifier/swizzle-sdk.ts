import { type BinaryToTextEncoding, createHmac, timingSafeEqual } from "node:crypto";
import { writeSync } from "node:fs";
import { readFile } from "node:fs/promises";

export interface AutomationMetadata {
  /** The retry attempt this execution spends; a resume from a wait starts again at 1. */
  readonly attempt: number | null;
  readonly automationId: string | null;
  readonly automationName: string | null;
  readonly automationVersion: string | null;
  readonly environment: string | null;
  /** Which execution of the run this is, counting every resume and retry. */
  readonly executionNumber: number | null;
  readonly runId: string | null;
  /**
   * What started the run. Only `webhook` passed the trigger's signature check. A run started by
   * hand, on the platform or with `swizzle run`, is `manual` and has no webhook headers. An API
   * check reads `check`.
   */
  readonly triggerType: "webhook" | "cron" | "chain" | "manual" | "check" | null;
  readonly versionId: string | null;
}

export interface StepLogEntry {
  readonly details?: unknown;
  readonly level: "info";
  readonly message: string;
  readonly timestamp: string;
  readonly type: "step";
}

export interface AutomationContext<TPayload = unknown> {
  readonly metadata: AutomationMetadata;
  readonly payload: TPayload;
  logStep(message: string, details?: unknown): void;
}

export interface VerifyHmacOptions {
  readonly algorithm?: string;
  readonly digest?: BinaryToTextEncoding;
  readonly payload?: string | Buffer;
  readonly prefix?: string;
  readonly secret: string;
  readonly signature: string | null | undefined;
}

export interface InvokeResult<TResult = unknown> {
  readonly automation: string;
  readonly errorCode: string | null;
  readonly result: TResult | null;
  readonly runId: string;
  readonly status: "succeeded" | "dead-lettered";
}

export interface WaitForEventOptions {
  readonly timeoutMs?: number;
  readonly until?: Date | string;
}

export interface WaitForEventResult<TValue = unknown> {
  readonly timedOut: boolean;
  readonly value: TValue | null;
}

export interface RequestApprovalOptions extends WaitForEventOptions {
  /**
   * Who decides: a Swizzle person by email, or any member of a Swizzle team by name, signed in to
   * the dashboard. Without it, the approval link or anyone who may run the automation decides.
   */
  readonly assignee?: { readonly user: string } | { readonly team: string };
  readonly details?: unknown;
}

/** Whom the approval was assigned to when it was decided. */
export type ApprovalAssignee =
  | { readonly kind: "user"; readonly userId: string; readonly label: string }
  | { readonly kind: "team"; readonly teamId: string; readonly label: string };

/** Who decided: a signed-in person or the holder of the approval link. */
export type ApprovalDecider =
  | { readonly kind: "person"; readonly userId: string; readonly label: string }
  | { readonly kind: "link" };

/** The decision; a timed-out approval is rejected and names nobody. */
export type ApprovalResult =
  | {
      readonly timedOut: false;
      readonly approved: boolean;
      readonly assignee: ApprovalAssignee | null;
      readonly decidedBy: ApprovalDecider;
      readonly comment: string | null;
      readonly decidedAt: string;
    }
  | {
      readonly timedOut: true;
      readonly approved: false;
      readonly assignee: ApprovalAssignee | null;
      readonly decidedBy: null;
      readonly comment: null;
      readonly decidedAt: string;
    };

export async function readPayload<TPayload = unknown>(): Promise<TPayload> {
  const chunks: string[] = [];

  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = chunks.join("").trim();
  return (raw.length === 0 ? {} : JSON.parse(raw)) as TPayload;
}

export function getAutomationMetadata(): AutomationMetadata {
  return {
    attempt: parseOptionalInteger(process.env.SWIZZLE_ATTEMPT),
    automationId: process.env.SWIZZLE_AUTOMATION_ID ?? null,
    automationName: process.env.SWIZZLE_AUTOMATION_NAME ?? null,
    automationVersion: process.env.SWIZZLE_AUTOMATION_VERSION ?? null,
    environment: process.env.SWIZZLE_ENV ?? null,
    executionNumber: parseOptionalInteger(process.env.SWIZZLE_EXECUTION),
    runId: process.env.SWIZZLE_RUN_ID ?? null,
    // The platform sets it to one of the declared types.
    triggerType: (process.env.SWIZZLE_TRIGGER_TYPE ?? null) as AutomationMetadata["triggerType"],
    versionId: process.env.SWIZZLE_VERSION_ID ?? null,
  };
}

/**
 * Read the access token for a platform connection declared in `config.yaml`
 * under `connections:`. The platform injects the current (auto-refreshed) token
 * as `SWIZZLE_CONNECTION_<NAME>`; refresh tokens and client secrets never
 * reach automation code. Throws if the connection was not injected — usually
 * because it is not declared in `connections:` or is not authorized yet.
 */
export function getConnectionToken(connectionName: string): string {
  const token = process.env[connectionEnvVarName(connectionName)];
  if (token === undefined || token === "") {
    throw new Error(
      `Connection "${connectionName}" is not available. Declare it under connections: in config.yaml and authorize it with \`swizzle connections authorize ${connectionName} --provider <provider> --client-id <id> --client-secret-env <VAR>\`.`,
    );
  }
  return token;
}

/**
 * The ISO expiry of the injected connection access token, when the provider
 * supplied one. The platform refreshes tokens automatically, so this is only
 * useful for long-running automations that want to re-read the token.
 */
export function getConnectionTokenExpiry(connectionName: string): string | null {
  return process.env[`${connectionEnvVarName(connectionName)}_EXPIRES_AT`] ?? null;
}

function connectionEnvVarName(connectionName: string): string {
  return `SWIZZLE_CONNECTION_${connectionName.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

let cachedState: Record<string, unknown> | null = null;
let cachedStateFile: string | null = null;
let cachedSteps: Record<string, unknown> | null = null;
let cachedStepsFile: string | null = null;
const completedSteps = new Map<string, unknown>();
const CLAIM_PREFIX = "claim:";
const paceLastCallByName = new Map<string, number>();
const warnedUnknownPaceNames = new Set<string>();

export async function stateGet<TValue = unknown>(
  key: string,
  defaultValue?: TValue,
): Promise<TValue> {
  const state = await readStateSnapshot();
  return (Object.hasOwn(state, key) ? state[key] : defaultValue) as TValue;
}

export function stateSet(key: string, value: unknown): void {
  assertJson(value, `Swizzle state value "${key}"`);
  process.stderr.write(`${JSON.stringify({ key, type: "state_set", value })}\n`);
}

export function stateDelete(key: string): void {
  process.stderr.write(`${JSON.stringify({ key, type: "state_delete" })}\n`);
}

/**
 * Run a named durable step. A step_start event tells the platform the step runs; the
 * successful JSON-serializable result is emitted as step_result and memoized per run, so
 * retries return the persisted value without re-executing fn. Undefined results are stored
 * as null.
 */
export async function runStep<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const stepName = validateStepName(name);
  const memoized = await readMemoizedStep<T>(stepName);
  if (memoized.hit) {
    return memoized.value;
  }

  // The dashboard lights this step's station now; a crash before step_result marks it failed.
  process.stderr.write(`${JSON.stringify({ key: stepName, type: "step_start" })}\n`);
  const result = await fn();
  const value = result === undefined ? null : result;
  assertJson(value, `Swizzle step "${stepName}" result`);
  process.stderr.write(`${JSON.stringify({ key: stepName, type: "step_result", value })}\n`);
  completedSteps.set(stepName, value);
  return value as T;
}

/**
 * Durably sleep until an ISO timestamp or Date. On the first call for a step
 * name, this writes a suspend sentinel to stdout and exits the process with
 * code 0. When the platform resumes the run, the whole entrypoint runs again
 * and this helper returns immediately from the memoized step result.
 */
export async function sleepUntil(name: string, until: Date | string): Promise<void> {
  const stepName = validateStepName(name);
  const memoized = await readMemoizedStep(stepName);
  if (memoized.hit) {
    return;
  }

  const date = until instanceof Date ? until : new Date(until);
  if (Number.isNaN(date.getTime())) {
    throw new Error("sleepUntil requires a valid Date or ISO timestamp string.");
  }

  suspendAndExit({
    reason: "sleep",
    stepKey: stepName,
    until: date.toISOString(),
  });
}

/**
 * Durably sleep for a duration in milliseconds. On a miss this helper exits the
 * process after emitting the suspend sentinel; it never returns on that path.
 */
export async function sleep(name: string, durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs)) {
    throw new Error("sleep durationMs must be a finite number.");
  }
  await sleepUntil(name, new Date(Date.now() + durationMs));
}

/**
 * Invoke another automation as a durable child step. On the first call for a
 * step name, this writes a suspend sentinel to stdout and exits 0. On resume it
 * returns the memoized child result envelope. Child failure is returned as data
 * with status "dead-lettered"; it is not thrown by this helper.
 */
export async function invokeAutomation<TResult = unknown>(
  name: string,
  automation: string,
  payload: unknown,
): Promise<InvokeResult<TResult>> {
  const stepName = validateStepName(name);
  const memoized = await readMemoizedStep<InvokeResult<TResult>>(stepName);
  if (memoized.hit) {
    return memoized.value;
  }

  if (typeof automation !== "string" || automation.length === 0) {
    throw new Error("invokeAutomation automation must be a non-empty string.");
  }
  assertJson(payload, `Swizzle step "${stepName}" payload`);

  suspendAndExit({
    automation,
    payload,
    reason: "child",
    stepKey: stepName,
  });
}

export async function waitForEvent<TValue = unknown>(
  name: string,
  options: WaitForEventOptions = {},
): Promise<WaitForEventResult<TValue>> {
  const stepName = validateStepName(name);
  const memoized = await readMemoizedStep<WaitForEventResult<TValue>>(stepName);
  if (memoized.hit) {
    return memoized.value;
  }

  suspendAndExit({
    approval: false,
    reason: "event",
    stepKey: stepName,
    until: normalizeOptionalUntil(options),
  });
}

export async function requestApproval(
  name: string,
  options: RequestApprovalOptions = {},
): Promise<ApprovalResult> {
  const stepName = validateStepName(name);
  const memoized = await readMemoizedStep<ApprovalResult>(stepName);
  if (memoized.hit) {
    return memoized.value;
  }

  suspendAndExit({
    approval: true,
    assignee: options.assignee ?? null,
    details: options.details ?? null,
    reason: "event",
    stepKey: stepName,
    until: normalizeOptionalUntil(options),
  });
}

/**
 * The public link that opens the approval page of one approval step. It works only while the run
 * waits at that step, at most until the wait's timeout. Send it inside a `step`, so a resume
 * does not send it again. What readers see of the run, its logs, steps, details, state and child
 * payloads, shows it as `[REDACTED]`, so whoever may only read the run cannot decide with it.
 */
export function getApprovalUrl(step: string): string {
  return createWaitLink("approvals", "approval", step);
}

/**
 * The public URL a third-party system POSTs to, without a Swizzle credential, to resolve the
 * `waitForEvent` of one step; the request body becomes the event value.
 */
export function getEventCallbackUrl(step: string): string {
  return createWaitLink("events", "event", step);
}

// `<runId>.<base64url(step)>.<base64url(HMAC-SHA256(SWIZZLE_LINK_KEY, "<kind>\n<step>"))>`, the
// token packages/runtime/src/wait-links.ts verifies.
function createWaitLink(path: "approvals" | "events", kind: "approval" | "event", step: string) {
  const stepName = validateStepName(step);
  const base = process.env.SWIZZLE_LINK_URL?.trim();
  const key = process.env.SWIZZLE_LINK_KEY;
  const runId = process.env.SWIZZLE_RUN_ID;
  if (!base || !key || !runId) {
    throw new Error(
      "SWIZZLE_LINK_URL and SWIZZLE_LINK_KEY are not available. Only deployed runs receive them, when the worker has SWIZZLE_LINK_URL and SWIZZLE_ENCRYPTION_KEY.",
    );
  }
  const signature = createHmac("sha256", key).update(`${kind}\n${stepName}`).digest("base64url");
  const token = `${runId}.${Buffer.from(stepName).toString("base64url")}.${signature}`;
  return `${base.replace(/\/+$/, "")}/${path}/${token}`;
}

async function readMemoizedStep<T>(
  stepName: string,
): Promise<{ readonly hit: true; readonly value: T } | { readonly hit: false }> {
  if (completedSteps.has(stepName)) {
    return { hit: true, value: completedSteps.get(stepName) as T };
  }

  const snapshot = await readStepsSnapshot();
  if (Object.hasOwn(snapshot, stepName)) {
    const value = snapshot[stepName];
    completedSteps.set(stepName, value);
    return { hit: true, value: value as T };
  }

  return { hit: false };
}

function suspendAndExit(suspend: Record<string, unknown> & { readonly stepKey: string }): never {
  assertJson(suspend, `Swizzle step "${suspend.stepKey}"`);
  writeSync(1, `${JSON.stringify({ $swizzle: { suspend } })}\n`);
  process.exit(0);
}

function normalizeOptionalUntil(options: WaitForEventOptions): string | null {
  if (options.until !== undefined) {
    const date = options.until instanceof Date ? options.until : new Date(options.until);
    if (Number.isNaN(date.getTime())) {
      throw new Error("until must be a valid Date or ISO timestamp string.");
    }
    return date.toISOString();
  }
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new Error("timeoutMs must be a finite non-negative number.");
    }
    return new Date(Date.now() + options.timeoutMs).toISOString();
  }
  return null;
}

/**
 * Claims `key` in the automation's state for this run: true for the first run that claims it, and
 * again for that run's retries and resumes; false for every other run. The platform decides with
 * one insert in PostgreSQL, so of two runs that claim a key at the same time exactly one gets
 * true. Claim before a side effect that must happen once, such as sending order A-1001.
 *
 * The first call suspends the run, and the entrypoint runs again from the top with the answer, so
 * code before it runs twice. The claim stays under the state key `claim:<key>`; delete that key
 * to let a later run claim it again. A local `swizzle run` holds no platform state and gets true.
 */
export async function claim(key: string): Promise<boolean> {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("Swizzle claim keys must be non-empty strings.");
  }
  if (normalizeSnapshotFile(process.env.SWIZZLE_STATE_FILE) === null) return true;
  const stepKey = `${CLAIM_PREFIX}${key}`;
  const snapshot = await readStepsSnapshot();
  if (Object.hasOwn(snapshot, stepKey)) {
    return (snapshot[stepKey] as { readonly claimed?: unknown }).claimed === true;
  }
  suspendAndExit({ reason: "claim", stepKey });
}

async function readStateSnapshot(): Promise<Record<string, unknown>> {
  const stateFile = normalizeSnapshotFile(process.env.SWIZZLE_STATE_FILE);
  if (cachedState !== null && cachedStateFile === stateFile) return cachedState;
  cachedStateFile = stateFile;
  if (stateFile === null) {
    cachedState = {};
    return cachedState;
  }
  const parsed = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
  cachedState = isRecord(parsed) ? parsed : {};
  return cachedState;
}

async function readStepsSnapshot(): Promise<Record<string, unknown>> {
  const stepsFile = normalizeSnapshotFile(process.env.SWIZZLE_STEPS_FILE);
  if (cachedSteps !== null && cachedStepsFile === stepsFile) return cachedSteps;
  cachedStepsFile = stepsFile;
  if (stepsFile === null) {
    cachedSteps = {};
    return cachedSteps;
  }

  try {
    const parsed = JSON.parse(await readFile(stepsFile, "utf8")) as unknown;
    cachedSteps = isRecord(parsed) ? parsed : {};
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
    if (code !== "ENOENT") {
      throw error;
    }
    cachedSteps = {};
  }
  return cachedSteps;
}

function normalizeSnapshotFile(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  return value;
}

/**
 * Throws when `value` has no JSON form the platform can store and give back. JSON.stringify
 * writes null for NaN and Infinity, a string for a Date, {} for a Map or Set, and drops an
 * undefined field, so a replayed step would return another value than the run saw. Only
 * null, booleans, finite numbers, strings, arrays and plain objects round-trip, and only when
 * serialization runs no code of the value's own: a toJSON method rewrites it, and a getter can
 * answer differently when serialization reads it again. The walk reads each property once
 * through its descriptor, so what it validates is what JSON.stringify then writes.
 */
function assertJson(value: unknown, what: string, key = "", ancestors: object[] = []): void {
  const lossy = lossyKind(value);
  if (lossy !== null) throw notJson(what, lossy, key);
  if (typeof value !== "object" || value === null) return;
  if (ancestors.includes(value)) throw notJson(what, "a cycle", key);
  if ("toJSON" in value) throw notJson(what, "a toJSON method", "toJSON");
  const path = [...ancestors, value];
  const names = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => String(index))
    : Object.keys(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined) throw notJson(what, "a hole", name);
    if (!("value" in descriptor)) throw notJson(what, "a getter", name);
    assertJson(descriptor.value, what, name, path);
  }
}

function notJson(what: string, found: string, key: string): Error {
  return new Error(
    `${what} is not JSON: ${found}${key === "" ? "" : ` at "${key}"`} has no JSON form.`,
  );
}

/** Names what a value is when JSON would change it or drop it, or null when it round-trips. */
function lossyKind(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : String(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value !== "object")
    return typeof value === "undefined" ? "undefined" : `a ${typeof value}`;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (Array.isArray(value) || prototype === Object.prototype || prototype === null) return null;
  return `a ${value.constructor?.name ?? "non-plain object"}`;
}

function validateStepName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Swizzle step names must be non-empty strings.");
  }
  // claim() keeps its answers under these names; a step of the same name would forge one.
  if (name.startsWith(CLAIM_PREFIX)) {
    throw new Error(`Swizzle step names starting with "${CLAIM_PREFIX}" are reserved for claim().`);
  }
  return name;
}

export function getWebhookHeaders(): Record<string, string> {
  const rawHeaders = process.env.SWIZZLE_WEBHOOK_HEADERS;
  if (rawHeaders === undefined || rawHeaders.trim() === "") {
    return {};
  }

  const parsed = JSON.parse(rawHeaders) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

export async function getRawBody(): Promise<Buffer> {
  const rawBodyPath = process.env.SWIZZLE_WEBHOOK_RAW_BODY_PATH;
  if (rawBodyPath === undefined || rawBodyPath.trim() === "") {
    return Buffer.alloc(0);
  }

  return await readFile(rawBodyPath);
}

export async function verifyHmac(options: VerifyHmacOptions): Promise<boolean> {
  const signature = normalizeSignature(options.signature, options.prefix ?? "");
  if (signature === null || options.secret === "") {
    return false;
  }

  const digest = options.digest ?? "hex";
  const payload =
    options.payload === undefined
      ? await getRawBody()
      : typeof options.payload === "string"
        ? Buffer.from(options.payload)
        : options.payload;
  const expected = createHmac(options.algorithm ?? "sha256", options.secret)
    .update(payload)
    .digest(digest);

  return timingSafeStringEqual(signature, expected);
}

export function logStep(message: string, details?: unknown): void {
  const entry: StepLogEntry = {
    ...(details !== undefined ? { details } : {}),
    level: "info",
    message,
    timestamp: new Date().toISOString(),
    type: "step",
  };

  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export function writeResult(result: unknown): void {
  assertJson(result, "The automation result");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function runAutomation<TPayload = unknown, TResult = unknown>(
  handler: (context: AutomationContext<TPayload>) => Promise<TResult> | TResult,
): Promise<void> {
  const payload = await readPayload<TPayload>();
  const metadata = getAutomationMetadata();
  const context: AutomationContext<TPayload> = {
    logStep,
    metadata,
    payload,
  };

  const result = await handler(context);
  writeResult(result);
}

/** The field an API answer no longer matches, as the automation's own parser found it. */
export interface ContractChange {
  readonly api: string;
  readonly expected: string;
  readonly field: string;
  readonly got: string;
}

const reportedApiContacts = new Set<string>();

/**
 * `fetch` that also tells the platform which API answered: one `api_contact` stderr line per
 * distinct host, status and retirement notice, so the dashboard shows when an API was last
 * reached and warns about Deprecation and Sunset headers. Only the host, the path without its
 * query, the status and those headers leave the process; the platform redacts the path. After a
 * redirect, the event names the URL that answered.
 */
export async function apiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const url = new URL(response.url === "" ? input : response.url);
  const deprecation = response.headers.get("deprecation");
  const sunset = response.headers.get("sunset");
  const key = [url.host, response.status, deprecation, sunset].join("\n");
  if (!reportedApiContacts.has(key)) {
    reportedApiContacts.add(key);
    process.stderr.write(
      `${JSON.stringify({
        host: url.host,
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        status: response.status,
        ...(deprecation !== null ? { deprecation } : {}),
        ...(sunset !== null ? { sunset } : {}),
        ...((deprecation !== null || sunset !== null) && response.headers.has("link")
          ? { link: response.headers.get("link") }
          : {}),
        timestamp: new Date().toISOString(),
        type: "api_contact",
      })}\n`,
    );
  }
  return response;
}

/**
 * Ends the process because an API's answer no longer matches what the code expects. Name the
 * field and describe both sides as phrases, such as `{ api: "api.example.com", field:
 * "items[].amount", expected: "a number", got: "a string" }`. A run fails with
 * UPSTREAM_CONTRACT_CHANGED and is not retried; an API check records drift.
 */
export function contractChanged(change: ContractChange): never {
  writeSync(2, `${JSON.stringify({ ...change, type: "contract_changed" })}\n`);
  process.exit(1);
}

export function recordRateLimitUsage(group: string, count = 1): void {
  const entry = {
    count,
    group,
    timestamp: new Date().toISOString(),
    type: "rate_limit_usage",
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export async function pace(name: string): Promise<void> {
  const rate = getDeclaredRateLimits()[name];
  if (rate === undefined) {
    if (!warnedUnknownPaceNames.has(name)) {
      warnedUnknownPaceNames.add(name);
      process.stderr.write(
        `${JSON.stringify({
          name,
          timestamp: new Date().toISOString(),
          type: "pace_unknown_rate_limit",
        })}\n`,
      );
    }
    return;
  }

  const spacingMs = parseRateSpacingMs(rate);
  if (spacingMs === null) return;
  const now = Date.now();
  const nextAllowedAt = (paceLastCallByName.get(name) ?? 0) + spacingMs;
  const waitMs = Math.max(0, nextAllowedAt - now);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  paceLastCallByName.set(name, Date.now());
}

function getDeclaredRateLimits(): Record<string, string> {
  const raw = process.env.SWIZZLE_RATE_LIMITS;
  if (raw === undefined || raw.trim() === "") return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string",
    ),
  );
}

function parseRateSpacingMs(rate: string): number | null {
  const match = rate.trim().match(/^(\d+)\/(sec|min|hour)$/);
  if (!match) return null;
  const max = Number(match[1]);
  if (!Number.isFinite(max) || max <= 0) return null;
  const unitMs = match[2] === "sec" ? 1_000 : match[2] === "min" ? 60_000 : 3_600_000;
  return unitMs / max;
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeSignature(signature: string | null | undefined, prefix: string): string | null {
  if (signature === null || signature === undefined) {
    return null;
  }

  const trimmed = signature.trim();
  return prefix !== "" && trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

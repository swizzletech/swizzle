// The structured stderr lines automation code prints, and the two that tell the platform about
// the outside APIs it calls: `api_contact` for each distinct answer `apiFetch` / `api_request`
// saw, and `contract_changed` when the code's own parser found the answer changed. Runs and
// checks both read contacts and contract changes from stderr. The platform never
// looks at response bodies. `readExecutionSignals` folds contacts and `rate_limit_usage` into the
// execution's state as its output arrives, so an execution keeps them however it ends.
import type { ApiContactObservation, ApiNoticeObservation, ExecutionSignals } from "@swizzle/db";

import type { OutputRedactor } from "./output-redaction.js";

/** One structured stderr line: a JSON object with a string `type`. */
export type StructuredEvent = Record<string, unknown> & { readonly type: string };

/**
 * Hands each complete structured line of `buffer + chunk` to `onEvent` and returns the unfinished
 * tail, the next call's buffer. Other lines are ordinary logs and are skipped.
 */
export function readStructuredEvents(
  buffer: string,
  chunk: string,
  onEvent: (event: StructuredEvent) => void,
): string {
  const lines = (buffer + chunk).split(/\r?\n/u);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(event) && typeof event.type === "string") onEvent(event as StructuredEvent);
  }
  return rest;
}

export const NO_SIGNALS: ExecutionSignals = { contacts: {}, rateLimitUsage: {} };

/**
 * Adds the `api_contact` and `rate_limit_usage` events of the complete lines of `line + chunk` to
 * `signals`, and returns them with the unfinished tail. A chunk of "\n" reads the last line.
 */
export function readExecutionSignals(
  signals: ExecutionSignals,
  line: string,
  chunk: string,
  observedAt: string,
): { readonly signals: ExecutionSignals; readonly line: string } {
  const contacts = new ApiContactLog(signals.contacts);
  const rateLimitUsage = { ...signals.rateLimitUsage };
  const rest = readStructuredEvents(line, chunk, (event) => {
    if (event.type === "api_contact") contacts.record(event, observedAt);
    if (event.type !== "rate_limit_usage") return;
    const group = typeof event.group === "string" ? event.group : "";
    const count = typeof event.count === "number" && Number.isFinite(event.count) ? event.count : 1;
    if (group.length > 0 && count > 0) rateLimitUsage[group] = (rateLimitUsage[group] ?? 0) + count;
  });
  return { signals: { contacts: contacts.contacts(), rateLimitUsage }, line: rest };
}

/** A field the automation's parser named when the API's answer stopped matching. */
interface ContractChange {
  readonly api: string;
  readonly expected: string;
  readonly field: string;
  readonly got: string;
}

/** An execution that names more hosts than this is not reporting real API calls; the rest are dropped. */
const MAX_HOSTS_PER_EXECUTION = 50;
const MAX_TEXT_LENGTH = 512;

type HostContact = ExecutionSignals["contacts"][string];

/** Folds one execution's `api_contact` events per host, written once when the execution ends. */
export class ApiContactLog {
  private readonly hosts: Map<string, HostContact>;

  constructor(contacts: ExecutionSignals["contacts"] = {}) {
    this.hosts = new Map(Object.entries(contacts));
  }

  record(event: Record<string, unknown>, observedAt: string): void {
    const host = typeof event.host === "string" ? event.host.trim().toLowerCase() : "";
    const status = event.status;
    if (host === "" || host.length > 255 || typeof status !== "number") return;
    if (!Number.isInteger(status) || status < 100 || status > 599) return;
    const known = this.hosts.get(host);
    if (known === undefined && this.hosts.size >= MAX_HOSTS_PER_EXECUTION) return;

    const at = parseTimestamp(event.timestamp) ?? observedAt;
    const notice = parseNotice(event, at);
    const contact: HostContact = known ?? {
      lastContactAt: at,
      lastOkAt: null,
      lastStatus: status,
      notice: null,
    };
    const latest = at >= contact.lastContactAt;
    const ok =
      status >= 200 && status < 300 && (contact.lastOkAt === null || at > contact.lastOkAt);
    this.hosts.set(host, {
      lastContactAt: latest ? at : contact.lastContactAt,
      lastOkAt: ok ? at : contact.lastOkAt,
      lastStatus: latest ? status : contact.lastStatus,
      notice:
        notice === null
          ? contact.notice
          : {
              deprecatedAt: notice.deprecatedAt ?? contact.notice?.deprecatedAt ?? null,
              path: contact.notice?.path ?? notice.path,
              sunsetAt: notice.sunsetAt ?? contact.notice?.sunsetAt ?? null,
              url: notice.url ?? contact.notice?.url ?? null,
            },
    });
  }

  /** The log as the execution's state keeps it between requests. */
  contacts(): ExecutionSignals["contacts"] {
    return Object.fromEntries(this.hosts);
  }

  /** The observations with each notice path and link passed through the execution's redactor. */
  observations(redactor: OutputRedactor): readonly ApiContactObservation[] {
    return [...this.hosts].map(([host, contact]) => ({
      host,
      lastContactAt: contact.lastContactAt,
      lastOkAt: contact.lastOkAt,
      lastStatus: contact.lastStatus,
      notice:
        contact.notice === null
          ? null
          : {
              ...contact.notice,
              path: contact.notice.path === null ? null : redactor.text(contact.notice.path),
              url: contact.notice.url === null ? null : redactor.text(contact.notice.url),
            },
    }));
  }
}

/** The last `contract_changed` event in a process's stderr, or null. */
export function findContractChange(stderr: string): ContractChange | null {
  let found: ContractChange | null = null;
  readStructuredEvents("", `${stderr}\n`, (event) => {
    if (event.type !== "contract_changed") return;
    const api = boundedText(event.api);
    const field = boundedText(event.field);
    if (api === null || field === null) return;
    found = {
      api,
      expected: boundedText(event.expected) ?? "something else",
      field,
      got: boundedText(event.got) ?? "different",
    };
  });
  return found;
}

/**
 * The failure a non-zero exit becomes when the process reported a contract change: terminal,
 * because a retry cannot fix a changed API and would only spend calls.
 */
export function contractChangeFailure(
  stderr: string,
):
  | { readonly code: "UPSTREAM_CONTRACT_CHANGED"; readonly message: string }
  | Record<string, never> {
  const change = findContractChange(stderr);
  return change === null
    ? {}
    : { code: "UPSTREAM_CONTRACT_CHANGED", message: describeContractChange(change) };
}

/** "The API of api.example.com changed: items[].amount is a string, expected a number." */
function describeContractChange(change: ContractChange): string {
  return `The API of ${change.api} changed: ${change.field} is ${change.got}, expected ${change.expected}.`;
}

function parseNotice(event: Record<string, unknown>, at: string): ApiNoticeObservation | null {
  const deprecatedAt = parseDeprecation(boundedText(event.deprecation), at);
  const sunsetText = boundedText(event.sunset);
  const sunsetAt = sunsetText === null ? null : parseHttpDate(sunsetText);
  if (deprecatedAt === null && sunsetAt === null) return null;
  return {
    deprecatedAt,
    path: typeof event.path === "string" ? (event.path.split("?")[0] ?? null) : null,
    sunsetAt,
    url: typeof event.link === "string" ? noticeLink(event.link) : null,
  };
}

/** The target of the first Link entry with `rel="deprecation"` or `rel="sunset"` (RFC 9745, RFC 8594). */
function noticeLink(header: string): string | null {
  for (const match of header.matchAll(/<([^>]*)>([^,]*)/gu)) {
    const rel = /\brel\s*=\s*"?([^";]*)"?/iu.exec(match[2] ?? "")?.[1] ?? "";
    if (/\b(?:deprecation|sunset)\b/iu.test(rel))
      return match[1]?.slice(0, MAX_TEXT_LENGTH) ?? null;
  }
  return null;
}

/**
 * RFC 9745 sends `@<unix seconds>`; earlier drafts sent an HTTP date, or `true` for "deprecated
 * now". Any other value, such as `false` or a typo, announces nothing.
 */
function parseDeprecation(value: string | null, at: string): string | null {
  if (value === null) return null;
  return value.toLowerCase() === "true" ? at : parseHttpDate(value);
}

/** An ISO time, or null for a value that is no date or lies outside the range a Date holds. */
function parseHttpDate(value: string): string | null {
  const seconds = /^@(-?\d+)$/u.exec(value.trim())?.[1];
  const date = new Date(seconds !== undefined ? Number(seconds) * 1000 : Date.parse(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function boundedText(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().slice(0, MAX_TEXT_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

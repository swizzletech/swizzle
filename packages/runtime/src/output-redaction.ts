// Replaces the exact values a run was given, its secrets and connection access tokens, and every
// approval and event link token, in what the run prints, before the platform stores, streams or
// logs it. The attempt service builds a redactor from the attempt's sealed values for every output
// chunk and for the final result. Step values, state, payloads and wait details stay stored as
// the run wrote them, so a resume replays them; `redactWaitLinks` hides their links in serialized
// JSON answers to readers (apps/api/src/server.ts). The sandbox runner on the worker hides only
// its attempt's own tokens, because the API reads steps, state and suspends from what it reports.
//
// Only exact values and the link token shape are caught. Code that encodes a value first, in
// base64 or one character per line, gets it past the redactor; the redactor keeps honest output
// clean, it does not contain hostile code (docs/explanation/security-model.md).

import type { AutomationRunResult } from "./run-result.js";
import { findWaitLinkTokens, unfinishedWaitLinkTokenStart } from "./wait-links.js";

const REDACTED = "[REDACTED]";

export interface OutputRedactor {
  /** The text with every value replaced by REDACTED. */
  text(value: string): string;
  /** A JSON value with every value replaced in its strings and object keys. */
  json(value: unknown): unknown;
  /**
   * Redacts one output stream chunk by chunk. A value can arrive split across chunks, so `push`
   * holds back the text that could still become part of one, and the next `push` or `end`
   * releases it. The joined output equals `text` of the joined input.
   */
  stream(): { push(chunk: string): string; end(): string };
  /**
   * The stateless step of `stream`: `pending` is held back, as `push` would hold it. A caller that
   * keeps `pending` between requests passes it in front of the next chunk.
   */
  settle(text: string): { readonly settled: string; readonly pending: string };
}

interface RedactionPattern {
  ranges(value: string): [number, number][];
  pendingStart(value: string): number;
}

/** Exact secret and connection token values, as the worker may safely hide in its report. */
export function createOutputRedactor(values: readonly string[]): OutputRedactor {
  return createRedactor([exactValues(values)]);
}

/** Run output for readers: secrets and every approval or event link token. */
export function createRunOutputRedactor(values: readonly string[]): OutputRedactor {
  return createRedactor([
    exactValues(values),
    { ranges: findWaitLinkTokens, pendingStart: unfinishedWaitLinkTokenStart },
  ]);
}

function exactValues(values: readonly string[]): RedactionPattern {
  const secrets = [...new Set(values.filter((value) => value.length > 0))];
  const longest = Math.max(0, ...secrets.map((secret) => secret.length));
  return {
    ranges(value) {
      const found: [number, number][] = [];
      for (const secret of secrets) {
        for (let at = value.indexOf(secret); at !== -1; at = value.indexOf(secret, at + 1)) {
          found.push([at, at + secret.length]);
        }
      }
      return found;
    },
    pendingStart(value) {
      for (let at = Math.max(0, value.length - longest + 1); at < value.length; at++) {
        const tail = value.slice(at);
        if (secrets.some((secret) => secret.length > tail.length && secret.startsWith(tail)))
          return at;
      }
      return value.length;
    },
  };
}

function createRedactor(patterns: readonly RedactionPattern[]): OutputRedactor {
  // Merge overlaps so replacing one value cannot expose part of another.
  const ranges = (value: string) => {
    const found = patterns.flatMap((pattern) => pattern.ranges(value));
    found.sort((left, right) => left[0] - right[0]);
    const merged: [number, number][] = [];
    for (const [start, end] of found) {
      const last = merged.at(-1);
      if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged;
  };
  const text = (value: string) => {
    let result = "";
    let position = 0;
    for (const [start, end] of ranges(value)) {
      result += value.slice(position, start) + REDACTED;
      position = end;
    }
    return result + value.slice(position);
  };
  const json = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(json);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [text(key), json(item)]),
      );
    }
    return value;
  };
  // Where the text stops being final: the first point from which the rest could still grow into a
  // value or a link token, moved back to the start of any that spans it, because the next chunk
  // could no longer see where it began.
  const unsettled = (value: string) => {
    const cut = Math.min(...patterns.map((pattern) => pattern.pendingStart(value)));
    return ranges(value).find(([start, end]) => start < cut && cut < end)?.[0] ?? cut;
  };
  const settle = (value: string) => {
    const cut = unsettled(value);
    return { settled: text(value.slice(0, cut)), pending: value.slice(cut) };
  };
  return {
    json,
    settle,
    stream() {
      let pending = "";
      return {
        end() {
          const rest = text(pending);
          pending = "";
          return rest;
        },
        push(chunk) {
          const next = settle(pending + chunk);
          pending = next.pending;
          return next.settled;
        },
      };
    },
    text,
  };
}

/** Link tokens use only JSON-safe characters, so serialized JSON needs no decoding. */
export function redactWaitLinks(value: string): string {
  let result = "";
  let position = 0;
  for (const [start, end] of findWaitLinkTokens(value)) {
    result += value.slice(position, start) + REDACTED;
    position = end;
  }
  return result + value.slice(position);
}

/** A run or check result as the platform stores and shows it: output, failure message, cause and stack redacted. */
export function redactRunResult(
  execution: AutomationRunResult,
  redactor: OutputRedactor,
): AutomationRunResult {
  const output = {
    stderr: redactor.text(execution.stderr),
    stdout: redactor.text(execution.stdout),
  };
  if (execution.success)
    return { ...execution, ...output, result: redactor.json(execution.result) };
  return {
    ...execution,
    ...output,
    message: redactor.text(execution.message),
    ...(execution.cause != null ? { cause: redactor.text(execution.cause) } : {}),
    ...(execution.stack != null ? { stack: redactor.text(execution.stack) } : {}),
  };
}

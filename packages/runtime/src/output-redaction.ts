import type { AutomationRunResult } from "./run-result.js";
import { findWaitLinkTokens, unfinishedWaitLinkTokenStart } from "./wait-links.js";

const REDACTED = "[REDACTED]";

export interface OutputRedactor {
  text(value: string): string;
  json(value: unknown): unknown;
  stream(): { push(chunk: string): string; end(): string };
  settle(text: string): { readonly settled: string; readonly pending: string };
}

interface RedactionPattern {
  ranges(value: string): [number, number][];
  pendingStart(value: string): number;
}

export function createOutputRedactor(values: readonly string[]): OutputRedactor {
  return createRedactor([exactValues(values)]);
}

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

export function redactWaitLinks(value: string): string {
  let result = "";
  let position = 0;
  for (const [start, end] of findWaitLinkTokens(value)) {
    result += value.slice(position, start) + REDACTED;
    position = end;
  }
  return result + value.slice(position);
}

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

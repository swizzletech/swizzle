import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseAutomationConfig } from "@swizzle/config";

import { AgentError, EXIT_CODES } from "./output.js";

export interface AutomationLike {
  readonly automationSlug: string;
  readonly automationName?: string;
}

export interface ResolvedAutomation<T extends AutomationLike> {
  readonly automation: T;
  readonly match: "exact" | "fuzzy";
  readonly confidence: number;
}

export interface CwdAutomationContext {
  readonly name: string;
  readonly slug: string;
  readonly directory: string;
}

/** Read the closest config.yaml above or at cwd and return the declared name. */
export async function detectCwdAutomation(
  cwd = process.cwd(),
): Promise<CwdAutomationContext | undefined> {
  let current = path.resolve(cwd);
  const root = path.parse(current).root;
  while (current !== root) {
    const candidate = path.join(current, "config.yaml");
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const config = parseAutomationConfig(raw);
        return {
          directory: current,
          name: config.name,
          slug: slugify(config.name),
        };
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/** slugify mirrors the server-side logic: lowercase, non-alnum → `-`, trim edges. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

/**
 * Fuzzy-resolve an automation name against the candidates the caller can see.
 * Strategy: exact slug > exact displayName > prefix > substring > every word, in any order.
 * Null when none matches (with `exact`, when none matches exactly): the caller then asks the API.
 */
export function resolveAutomation<T extends AutomationLike>(
  query: string,
  candidates: readonly T[],
  options: { readonly exact?: boolean } = {},
): ResolvedAutomation<T> | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    throw new AgentError({
      code: "AUTOMATION_NAME_REQUIRED",
      message: "An automation name is required.",
      fixCommand: "swizzle list",
      hint: "Pass the automation name explicitly, or run from inside an automation directory.",
    });
  }

  const exactSlug = candidates.find((c) => c.automationSlug.toLowerCase() === normalizedQuery);
  if (exactSlug) {
    return { automation: exactSlug, confidence: 1, match: "exact" };
  }

  const exactName = candidates.find(
    (c) => (c.automationName ?? "").toLowerCase() === normalizedQuery,
  );
  if (exactName) {
    return { automation: exactName, confidence: 1, match: "exact" };
  }

  if (options.exact) {
    return null;
  }

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: fuzzyScore(normalizedQuery, candidate),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best === undefined) return null;

  const ambiguous =
    scored.length > 1 && (scored[1]?.score ?? 0) >= best.score * 0.85 && best.score < 1;
  if (ambiguous) {
    const alternatives = scored.slice(0, 5).map((entry) => entry.candidate.automationSlug);
    throw new AgentError({
      code: "AMBIGUOUS_AUTOMATION_NAME",
      message: `Automation name "${query}" is ambiguous. Candidates: ${alternatives.join(", ")}`,
      fixCommand: `swizzle resolve ${query}`,
      hint: "Use the full slug or pass --exact to disable fuzzy matching.",
      details: { alternatives, query },
    });
  }

  return { automation: best.candidate, confidence: best.score, match: "fuzzy" };
}

function fuzzyScore<T extends AutomationLike>(query: string, candidate: T): number {
  const slug = candidate.automationSlug.toLowerCase();
  const name = (candidate.automationName ?? "").toLowerCase();

  if (slug.startsWith(query) || name.startsWith(query)) return 0.9;
  if (slug.includes(query) || name.includes(query)) return 0.75;

  const queryTokens = tokenize(query);
  const candidateTokens = new Set([...tokenize(slug), ...tokenize(name)]);
  if (queryTokens.length === 0 || candidateTokens.size === 0) return 0;
  // Every word must match, in any order ("export nightly" finds nightly-export). One shared word
  // such as "verify" in verify-upstream and verify-probe names a different automation.
  return queryTokens.every((token) => candidateTokens.has(token)) ? 0.6 : 0;
}

function tokenize(value: string): string[] {
  return value.split(/[^a-z0-9]+/i).filter((token) => token.length > 1);
}

export interface TimeRange {
  readonly since?: string;
  readonly until?: string;
  readonly sinceLabel?: string;
}

const DURATION_RE = /^(\d+)\s*(ms|s|m|h|d|w)$/i;
const DURATION_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse agent-friendly time values.
 * Accepted:
 *   - ISO 8601 timestamps (2026-04-01T12:00:00Z)
 *   - Duration shorthand (1h, 30m, 2d, 1w)
 *   - Literal keywords: now, today
 */
function parseTimeValue(value: string, now = new Date()): Date {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AgentError({
      code: "INVALID_TIME_VALUE",
      exitCode: EXIT_CODES.usage,
      hint: "Use ISO 8601 (2026-04-01T12:00:00Z) or duration shorthand (1h, 30m, 2d).",
      message: "Time value must not be empty.",
    });
  }

  const lower = trimmed.toLowerCase();
  if (lower === "now") return new Date(now);
  if (lower === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }

  const durationMatch = DURATION_RE.exec(trimmed);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2]?.toLowerCase() ?? "s";
    const unitMs = DURATION_MS[unit];
    if (unitMs === undefined || Number.isNaN(amount)) {
      throw invalidTimeValue(value);
    }
    return new Date(now.getTime() - amount * unitMs);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidTimeValue(value);
  }
  return parsed;
}

export function parseTimeRange(
  since: string | undefined,
  until: string | undefined,
  now = new Date(),
): TimeRange {
  const sinceDate = since !== undefined ? parseTimeValue(since, now) : undefined;
  const untilDate = until !== undefined ? parseTimeValue(until, now) : undefined;

  if (sinceDate && untilDate && sinceDate.getTime() > untilDate.getTime()) {
    throw new AgentError({
      code: "INVALID_TIME_RANGE",
      exitCode: EXIT_CODES.usage,
      hint: "Swap the values, or drop --until for everything since --since.",
      message: "`--since` must be earlier than `--until`.",
      details: { since, until },
    });
  }

  const range: {
    -readonly [K in keyof TimeRange]: TimeRange[K];
  } = {};
  if (sinceDate && since !== undefined) {
    range.since = sinceDate.toISOString();
    range.sinceLabel = since;
  }
  if (untilDate) range.until = untilDate.toISOString();
  return range;
}

function invalidTimeValue(value: string): AgentError {
  return new AgentError({
    code: "INVALID_TIME_VALUE",
    exitCode: EXIT_CODES.usage,
    message: `Could not parse time value: ${value}`,
    hint: "Use ISO 8601 (2026-04-01T12:00:00Z) or duration shorthand (1h, 30m, 2d).",
  });
}

export interface RateLimitConfig {
  readonly groupName: string;
  readonly maxRequests: number;
  readonly windowMs: number;
}

const RATE_LIMIT_PATTERN = /^(\d+)\/(sec|min|hour)$/;

export function parseRateLimitSpec(groupName: string, spec: string): RateLimitConfig {
  const match = RATE_LIMIT_PATTERN.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid rate limit format for "${groupName}": "${spec}". Expected format like "60/min", "10/sec", or "1000/hour".`,
    );
  }

  const maxRequests = Number(match[1]);
  const unit = match[2] as "sec" | "min" | "hour";
  const windowMs = unit === "sec" ? 1_000 : unit === "min" ? 60_000 : 3_600_000;

  return { groupName, maxRequests, windowMs };
}

export function parseRateLimitsFromConfig(
  rateLimits: Record<string, string> | undefined,
): readonly RateLimitConfig[] {
  if (!rateLimits || Object.keys(rateLimits).length === 0) {
    return [];
  }

  return Object.entries(rateLimits).map(([groupName, spec]) => parseRateLimitSpec(groupName, spec));
}

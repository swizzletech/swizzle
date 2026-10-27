import { parseRateLimitsFromConfig, type RateLimitConfig } from "./rate-limit-parser.js";
import type { RateLimiter } from "./rate-limiter.js";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly blockedGroup?: string;
  readonly currentCount?: number;
  readonly limit?: number;
  readonly retryAfterMs?: number;
}

const MIN_RETRY_AFTER_MS = 1_000;

export async function checkAndRecordRunRateLimits(input: {
  readonly rateLimits: Record<string, string> | undefined;
  readonly rateLimiter: RateLimiter;
}): Promise<RateLimitDecision> {
  const groups: readonly RateLimitConfig[] = parseRateLimitsFromConfig(input.rateLimits);
  if (groups.length === 0) {
    return { allowed: true };
  }

  const results = await input.rateLimiter.checkAndRecord(groups);
  const blocked = results.find((r) => !r.allowed);
  if (!blocked) {
    return { allowed: true };
  }

  return {
    allowed: false,
    blockedGroup: blocked.groupName,
    currentCount: blocked.currentCount,
    limit: blocked.limit,
    retryAfterMs: Math.max(blocked.retryAfterMs ?? MIN_RETRY_AFTER_MS, MIN_RETRY_AFTER_MS),
  };
}

export function createInMemoryRateLimiter(options: { now?: () => number } = {}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, number[]>();

  const evict = (groupName: string, windowMs: number, currentTime: number): number[] => {
    const bucket = buckets.get(groupName) ?? [];
    const cutoff = currentTime - windowMs;
    const fresh = bucket.filter((ts) => ts > cutoff);
    if (fresh.length !== bucket.length) {
      buckets.set(groupName, fresh);
    }
    return fresh;
  };

  return {
    async checkLimits(groups) {
      const currentTime = now();
      return groups.map((group) => {
        const bucket = evict(group.groupName, group.windowMs, currentTime);
        const allowed = bucket.length < group.maxRequests;
        const retryAfterMs =
          !allowed && bucket.length > 0 && bucket[0] !== undefined
            ? Math.max(0, bucket[0] + group.windowMs - currentTime)
            : null;
        return {
          allowed,
          currentCount: bucket.length,
          groupName: group.groupName,
          limit: group.maxRequests,
          retryAfterMs,
          windowMs: group.windowMs,
        };
      });
    },
    async checkAndRecord(groups) {
      const currentTime = now();
      return groups.map((group) => {
        const bucket = evict(group.groupName, group.windowMs, currentTime);
        if (bucket.length < group.maxRequests) {
          bucket.push(currentTime);
          buckets.set(group.groupName, bucket);
          return {
            allowed: true,
            currentCount: bucket.length,
            groupName: group.groupName,
            limit: group.maxRequests,
            retryAfterMs: null,
            windowMs: group.windowMs,
          };
        }
        const retryAfterMs =
          bucket[0] !== undefined ? Math.max(0, bucket[0] + group.windowMs - currentTime) : 0;
        return {
          allowed: false,
          currentCount: bucket.length,
          groupName: group.groupName,
          limit: group.maxRequests,
          retryAfterMs,
          windowMs: group.windowMs,
        };
      });
    },
    async recordUsage(groupName, windowMs, count = 1) {
      const currentTime = now();
      const bucket = evict(groupName, windowMs, currentTime);
      for (let i = 0; i < count; i++) {
        bucket.push(currentTime);
      }
      buckets.set(groupName, bucket);
    },
    async getUtilization(groups) {
      const currentTime = now();
      return groups.map((group) => {
        const bucket = evict(group.groupName, group.windowMs, currentTime);
        return {
          currentCount: bucket.length,
          groupName: group.groupName,
          limit: group.maxRequests,
          utilizationPercent: group.maxRequests > 0 ? (bucket.length / group.maxRequests) * 100 : 0,
          windowMs: group.windowMs,
        };
      });
    },
    async close() {
      buckets.clear();
    },
  };
}

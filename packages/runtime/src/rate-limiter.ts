import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

import type { RateLimitConfig } from "./rate-limit-parser.js";

interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly currentCount: number;
  readonly groupName: string;
  readonly limit: number;
  readonly retryAfterMs: number | null;
  readonly windowMs: number;
}

interface RateLimitUtilization {
  readonly currentCount: number;
  readonly groupName: string;
  readonly limit: number;
  readonly utilizationPercent: number;
  readonly windowMs: number;
}

export interface RateLimiter {
  checkAndRecord(groups: readonly RateLimitConfig[]): Promise<readonly RateLimitCheckResult[]>;
  checkLimits(groups: readonly RateLimitConfig[]): Promise<readonly RateLimitCheckResult[]>;
  close(): Promise<void>;
  getUtilization(groups: readonly RateLimitConfig[]): Promise<readonly RateLimitUtilization[]>;
  recordUsage(groupName: string, windowMs: number, count?: number): Promise<void>;
}

const KEY_PREFIX = "swizzle:rate-limit:";

const CHECK_SCRIPT = `
local windowStart = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local maxAllowed = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', windowStart)
local count = redis.call('ZCARD', KEYS[1])
if count < maxAllowed then
  return {1, count}
else
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest and #oldest >= 2 then
    return {0, count, tonumber(oldest[2])}
  end
  return {0, count, 0}
end
`;

const CHECK_AND_RECORD_SCRIPT = `
local windowStart = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local maxAllowed = tonumber(ARGV[3])
local memberId = ARGV[4]
local ttlSeconds = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', windowStart)
local count = redis.call('ZCARD', KEYS[1])
if count < maxAllowed then
  redis.call('ZADD', KEYS[1], now, memberId)
  redis.call('EXPIRE', KEYS[1], ttlSeconds)
  return {1, count + 1}
else
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  if oldest and #oldest >= 2 then
    return {0, count, tonumber(oldest[2])}
  end
  return {0, count, 0}
end
`;

export function createRateLimiter(valkeyUrl: string): RateLimiter {
  const redis = new Redis(valkeyUrl, {
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    connectTimeout: 1000,
  });

  function keyFor(groupName: string): string {
    return `${KEY_PREFIX}${groupName}`;
  }

  return {
    async checkLimits(groups) {
      const now = Date.now();
      const results: RateLimitCheckResult[] = [];

      for (const group of groups) {
        const windowStart = now - group.windowMs;
        const raw = (await redis.eval(
          CHECK_SCRIPT,
          1,
          keyFor(group.groupName),
          windowStart,
          now,
          group.maxRequests,
        )) as [number, number] | [number, number, number];

        const allowed = raw[0] === 1;
        const currentCount = raw[1];
        const retryAfterMs =
          !allowed && raw.length === 3 ? Math.max(0, raw[2] + group.windowMs - now) : null;

        results.push({
          allowed,
          currentCount,
          groupName: group.groupName,
          limit: group.maxRequests,
          retryAfterMs,
          windowMs: group.windowMs,
        });
      }

      return results;
    },

    async checkAndRecord(groups) {
      const now = Date.now();
      const results: RateLimitCheckResult[] = [];

      for (const group of groups) {
        const windowStart = now - group.windowMs;
        const memberId = `${randomUUID()}-${now}`;
        const ttlSeconds = Math.ceil(group.windowMs / 1_000) + 1;
        const raw = (await redis.eval(
          CHECK_AND_RECORD_SCRIPT,
          1,
          keyFor(group.groupName),
          windowStart,
          now,
          group.maxRequests,
          memberId,
          ttlSeconds,
        )) as [number, number] | [number, number, number];

        const allowed = raw[0] === 1;
        const currentCount = raw[1];
        const retryAfterMs =
          !allowed && raw.length === 3 ? Math.max(0, raw[2] + group.windowMs - now) : null;

        results.push({
          allowed,
          currentCount,
          groupName: group.groupName,
          limit: group.maxRequests,
          retryAfterMs,
          windowMs: group.windowMs,
        });
      }

      return results;
    },

    async recordUsage(groupName, windowMs, count = 1) {
      const now = Date.now();
      const key = keyFor(groupName);
      const ttlSeconds = Math.ceil(windowMs / 1_000) + 1;

      for (let i = 0; i < count; i++) {
        const memberId = `${randomUUID()}-${now}-${i}`;
        await redis.zadd(key, now.toString(), memberId);
      }

      await redis.expire(key, ttlSeconds);
    },

    async getUtilization(groups) {
      const now = Date.now();
      const results: RateLimitUtilization[] = [];

      for (const group of groups) {
        const windowStart = now - group.windowMs;
        const key = keyFor(group.groupName);
        await redis.zremrangebyscore(key, "-inf", windowStart.toString());
        const currentCount = await redis.zcard(key);

        results.push({
          currentCount,
          groupName: group.groupName,
          limit: group.maxRequests,
          utilizationPercent: group.maxRequests > 0 ? (currentCount / group.maxRequests) * 100 : 0,
          windowMs: group.windowMs,
        });
      }

      return results;
    },

    async close() {
      await redis.quit();
    },
  };
}

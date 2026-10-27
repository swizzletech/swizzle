import { AutomationRuntimeError, parseRateLimitSpec, type RateLimitConfig } from "@swizzle/runtime";
import type { FastifyRequest } from "fastify";

import { normalizeClientIp } from "./http-shared.js";

/**
 * Sliding-window request budgets per client address for the API's public doors: webhook ingress
 * and approval links. The client address is the only key, so nothing a caller writes into a
 * request can mint a new budget. Memory is bounded by construction: at most `maxClients` clients,
 * each holding at most `maxRequests` timestamps. A new client past that bound first drops the
 * clients whose window has passed, then the least recently seen one; dropping a client only hands
 * it a fresh budget.
 */
export interface ClientRateLimiter {
  check(clientKey: string): RateLimitDecision;
}

interface RateLimitDecision {
  readonly allowed: boolean;
  readonly currentCount: number;
  readonly limit: number;
  readonly retryAfterMs: number;
  readonly windowMs: number;
}

const MAX_TRACKED_CLIENTS = 10_000;
const OFF_SPELLINGS = new Set(["false", "off", "disabled", "0"]);

/** The limiter `variable` configures, `defaultSpec` when it is unset, none when it is off. */
export function createClientRateLimiterFromEnvironment(
  variable: string,
  defaultSpec: string,
): ClientRateLimiter {
  const raw = process.env[variable]?.trim() || defaultSpec;
  if (OFF_SPELLINGS.has(raw.toLowerCase())) return createClientRateLimiter(null);
  try {
    return createClientRateLimiter(parseRateLimitSpec(variable, raw));
  } catch (error) {
    throw new AutomationRuntimeError(
      "AUTOMATION_CONFIG_INVALID",
      error instanceof Error ? error.message : `Invalid ${variable} value.`,
      {
        details: {
          expected: `Rate limit like "${defaultSpec}", "10/sec", "1000/hour", or "off".`,
          value: raw,
          variable,
        },
      },
    );
  }
}

export function createClientRateLimiter(
  config: RateLimitConfig | null,
  maxClients = MAX_TRACKED_CLIENTS,
): ClientRateLimiter {
  if (config === null) {
    return {
      check: () => ({
        allowed: true,
        currentCount: 0,
        limit: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        windowMs: 0,
      }),
    };
  }

  // Insertion order is the order of each client's latest counted request: only an allowed check
  // moves its client to the end, so the expired clients sit at the front.
  const buckets = new Map<string, number[]>();
  const decide = (allowed: boolean, bucket: readonly number[], retryAfterMs: number) => ({
    allowed,
    currentCount: bucket.length,
    limit: config.maxRequests,
    retryAfterMs,
    windowMs: config.windowMs,
  });

  return {
    check(clientKey) {
      const now = Date.now();
      const cutoff = now - config.windowMs;
      const bucket = (buckets.get(clientKey) ?? []).filter((timestamp) => timestamp > cutoff);
      if (bucket.length >= config.maxRequests) {
        // A denied client already has a bucket; setting it keeps its place in the order.
        buckets.set(clientKey, bucket);
        const oldest = bucket[0] ?? now;
        return decide(false, bucket, Math.max(1_000, oldest + config.windowMs - now));
      }
      buckets.delete(clientKey);
      if (buckets.size >= maxClients) evict(buckets, cutoff, maxClients);
      bucket.push(now);
      buckets.set(clientKey, bucket);
      return decide(true, bucket, 0);
    },
  };
}

// Walks from the client whose latest request is oldest: it drops expired clients, and while the
// map is still full, the least recently counted ones. Each call visits a client at most once.
function evict(buckets: Map<string, number[]>, cutoff: number, maxClients: number): void {
  for (const [key, timestamps] of buckets) {
    if (buckets.size < maxClients && (timestamps.at(-1) ?? 0) > cutoff) break;
    buckets.delete(key);
  }
}

/**
 * Fastify's resolved `request.ip`, which follows SWIZZLE_TRUSTED_PROXY: the socket address on
 * direct exposure, the real client from X-Forwarded-For behind a configured proxy. Reading
 * X-Forwarded-For directly would let a caller rotate it to mint budgets.
 */
export function clientKey(request: FastifyRequest): string {
  return normalizeClientIp(request.ip ?? request.socket.remoteAddress ?? "unknown");
}

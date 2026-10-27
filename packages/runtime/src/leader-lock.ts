import { Redis } from "ioredis";

import type { PlatformLogger } from "./platform-types.js";

export interface LeaderLockOptions {
  readonly instanceId: string;
  readonly key: string;
  readonly logger?: PlatformLogger;
  readonly onLeaderAcquired?: () => void | Promise<void>;
  readonly onLeaderLost?: () => void | Promise<void>;
  readonly renewIntervalMs?: number;
  readonly ttlMs?: number;
  readonly valkeyUrl?: string;
}

export interface LeaderLock {
  close(): Promise<void>;
  isLeader(): boolean;
  start(): Promise<void>;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";

export function createLeaderLock(options: LeaderLockOptions): LeaderLock {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(1000, Math.floor(ttlMs / 3));
  const url = options.valkeyUrl ?? DEFAULT_VALKEY_URL;
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });

  let leader = false;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  async function tryAcquireOrRenew(): Promise<void> {
    if (closed) return;

    try {
      if (leader) {
        // Renew: only if we still own it. Lua script keeps this atomic.
        const result = await client.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
          1,
          options.key,
          options.instanceId,
          String(ttlMs),
        );
        if (result !== 1) {
          leader = false;
          options.logger?.warn(
            { key: options.key, instanceId: options.instanceId },
            "Leader lock lost.",
          );
          await options.onLeaderLost?.();
        }
        return;
      }

      const acquired = await client.set(options.key, options.instanceId, "PX", ttlMs, "NX");
      if (acquired === "OK") {
        leader = true;
        options.logger?.info(
          { key: options.key, instanceId: options.instanceId, ttlMs },
          "Leader lock acquired.",
        );
        await options.onLeaderAcquired?.();
      }
    } catch (error) {
      options.logger?.error({ err: error, key: options.key }, "Leader lock tick failed.");
    }
  }

  return {
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;

      try {
        if (leader) {
          await client.eval(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
            1,
            options.key,
            options.instanceId,
          );
        }
      } catch {
        // Best-effort release; lock will expire via TTL.
      }

      leader = false;
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },

    isLeader() {
      return leader;
    },

    async start() {
      if (closed) return;
      if (client.status === "wait") {
        await client.connect();
      }
      await tryAcquireOrRenew();
      timer = setInterval(() => {
        void tryAcquireOrRenew();
      }, renewIntervalMs);
      timer.unref();
    },
  };
}

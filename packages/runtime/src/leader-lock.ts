import { randomUUID } from "node:crypto";
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

type Leadership =
  | { readonly kind: "idle" | "follower" | "closed" }
  | { readonly kind: "leader"; readonly until: number };

const CLAIM = `
  local owner = redis.call('GET', KEYS[1])
  if owner == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  if not owner then
    return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) and 1 or 0
  end
  return 0
`;
const RELEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

export function createLeaderLock(options: LeaderLockOptions): LeaderLock {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(1000, Math.floor(ttlMs / 3));
  const token = randomUUID();
  const client = new Redis(options.valkeyUrl ?? DEFAULT_VALKEY_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    commandTimeout: Math.min(ttlMs, 5_000),
    maxRetriesPerRequest: 0,
  });

  let state: Leadership = { kind: "idle" };
  let tickTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;

  const logFailure = (error: unknown) =>
    options.logger?.error({ err: error, key: options.key }, "Leader lock tick failed.");
  client.on("error", logFailure);

  const isClosed = () => state.kind === "closed";
  const isLeader = () => state.kind === "leader" && performance.now() < state.until;

  function loseLeadership() {
    if (state.kind !== "leader") return;
    clearTimeout(expiryTimer);
    state = { kind: "follower" };
    options.logger?.warn({ key: options.key, instanceId: options.instanceId }, "Leader lock lost.");
    void Promise.resolve()
      .then(() => options.onLeaderLost?.())
      .catch(logFailure);
  }

  async function tick() {
    if (isClosed()) return;
    try {
      const until = performance.now() + ttlMs;
      const acknowledged = await client.eval(CLAIM, 1, options.key, token, String(ttlMs));
      if (isClosed()) return;
      if (acknowledged !== 1 || performance.now() >= until) {
        loseLeadership();
        return;
      }
      if (!isLeader()) loseLeadership();
      const acquired = state.kind === "follower";
      state = { kind: "leader", until };
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(loseLeadership, Math.ceil(until - performance.now())).unref();
      if (acquired) {
        options.logger?.info(
          { key: options.key, instanceId: options.instanceId, ttlMs },
          "Leader lock acquired.",
        );
        await options.onLeaderAcquired?.();
      }
    } catch (error) {
      logFailure(error);
    } finally {
      if (!isClosed()) {
        tickTimer = setTimeout(() => void tick(), renewIntervalMs).unref();
      }
    }
  }

  return {
    async close() {
      if (isClosed()) return;
      state = { kind: "closed" };
      clearTimeout(tickTimer);
      clearTimeout(expiryTimer);
      try {
        if (client.status === "ready") await client.eval(RELEASE, 1, options.key, token);
      } catch (error) {
        logFailure(error);
      } finally {
        client.disconnect();
      }
    },

    isLeader,

    async start() {
      if (state.kind !== "idle") return;
      state = { kind: "follower" };
      await client.connect().catch(logFailure);
      await tick();
    },
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClientRateLimiter } from "./client-rate-limiter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("client rate limiter", () => {
  it("evicts an expired client before an active one, even after a denied check", () => {
    vi.useFakeTimers({ now: 0 });
    const limiter = createClientRateLimiter(
      { groupName: "test", maxRequests: 1, windowMs: 1_000 },
      2,
    );

    expect(limiter.check("a").allowed).toBe(true);
    vi.setSystemTime(500);
    expect(limiter.check("b").allowed).toBe(true);
    vi.setSystemTime(600);
    expect(limiter.check("a").allowed).toBe(false);
    vi.setSystemTime(1_100);
    limiter.check("c");

    // `a`'s request has expired and `b`'s has not, so `c` must displace `a`.
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("tracks at most maxClients clients and drops the least recently seen first", () => {
    const limiter = createClientRateLimiter(
      { groupName: "test", maxRequests: 1, windowMs: 60_000 },
      2,
    );

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    limiter.check("b");
    limiter.check("c");

    // A third client pushed `a` out, so `a` starts over while `c` keeps its spent budget.
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("c").allowed).toBe(false);
  });
});

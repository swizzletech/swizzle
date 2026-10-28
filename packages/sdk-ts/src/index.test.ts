import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { writeSyncMock } = vi.hoisted(() => ({
  writeSyncMock: vi.fn(() => 0),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: writeSyncMock,
  };
});

import { temporaryDirectory } from "../../../test/support.js";
import {
  apiFetch,
  getApprovalUrl,
  getConnectionToken,
  getConnectionTokenExpiry,
  getEventCallbackUrl,
  getRawBody,
  getWebhookHeaders,
  invokeAutomation,
  pace,
  recordRateLimitUsage,
  requestApproval,
  runStep,
  sleep,
  sleepUntil,
  stateDelete,
  stateGet,
  stateSet,
  verifyHmac,
  waitForEvent,
} from "./index.js";

afterEach(() => {
  vi.useRealTimers();
  writeSyncMock.mockReset();
  writeSyncMock.mockReturnValue(0);
});

describe("durable wait helpers", () => {
  it("returns memoized sleep hits without exiting", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await runStep("sleep-hit", () => ({ sleptUntil: "2030-01-01T00:00:00.000Z" }));
    await expect(sleepUntil("sleep-hit", "2030-01-01T00:00:00.000Z")).resolves.toBeUndefined();

    expect(writeSyncMock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("emits a sleep suspend sentinel and exits on misses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit ${code}`);
      }) as typeof process.exit);

      await expect(sleep("sleep-miss", 1_000)).rejects.toThrow("process.exit 0");

      expect(writeSyncMock).toHaveBeenCalledWith(
        1,
        `${JSON.stringify({
          $swizzle: {
            suspend: {
              reason: "sleep",
              stepKey: "sleep-miss",
              until: "2030-01-01T00:00:01.000Z",
            },
          },
        })}\n`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns memoized invoke hits and emits child sentinels on misses", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    const envelope = {
      automation: "child",
      errorCode: null,
      result: { ok: true },
      runId: "child-run",
      status: "succeeded" as const,
    };
    await runStep("invoke-hit", () => envelope);
    await expect(invokeAutomation("invoke-hit", "child", { ignored: true })).resolves.toEqual(
      envelope,
    );

    await expect(invokeAutomation("invoke-miss", "child", { hello: "world" })).rejects.toThrow(
      "process.exit 0",
    );

    expect(writeSyncMock).toHaveBeenLastCalledWith(
      1,
      `${JSON.stringify({
        $swizzle: {
          suspend: {
            automation: "child",
            payload: { hello: "world" },
            reason: "child",
            stepKey: "invoke-miss",
          },
        },
      })}\n`,
    );
  });

  // JSON.stringify drops an undefined or function payload from the envelope, so the child would
  // start with no input; the payload itself must be JSON.
  it.each([
    [
      "undefined",
      undefined,
      'Swizzle step "invoke-bad" payload is not JSON: undefined has no JSON form.',
    ],
    [
      "a function",
      () => 1,
      'Swizzle step "invoke-bad" payload is not JSON: a function has no JSON form.',
    ],
    [
      "NaN",
      { ratio: Number.NaN },
      'Swizzle step "invoke-bad" payload is not JSON: NaN at "ratio" has no JSON form.',
    ],
  ])("refuses to invoke a child with %s as payload", async (_name, payload, message) => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await expect(invokeAutomation("invoke-bad", "child", payload)).rejects.toThrow(message);
    expect(exit).not.toHaveBeenCalled();
    expect(writeSyncMock).not.toHaveBeenCalled();
  });

  it("returns memoized event and approval hits", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await runStep("event-hit", () => ({ timedOut: false, value: { ok: true } }));
    await expect(waitForEvent("event-hit")).resolves.toEqual({
      timedOut: false,
      value: { ok: true },
    });

    await runStep("approval-hit", () => ({
      approved: true,
      comment: "ok",
      decidedAt: "2026-07-09T00:00:00.000Z",
      timedOut: false,
    }));
    await expect(requestApproval("approval-hit")).resolves.toEqual({
      approved: true,
      comment: "ok",
      decidedAt: "2026-07-09T00:00:00.000Z",
      timedOut: false,
    });
  });

  it("emits event and approval suspend sentinels on misses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);

    await expect(waitForEvent("event-miss", { timeoutMs: 5_000 })).rejects.toThrow(
      "process.exit 0",
    );
    expect(writeSyncMock).toHaveBeenLastCalledWith(
      1,
      `${JSON.stringify({
        $swizzle: {
          suspend: {
            approval: false,
            reason: "event",
            stepKey: "event-miss",
            until: "2030-01-01T00:00:05.000Z",
          },
        },
      })}\n`,
    );

    await expect(
      requestApproval("approval-miss", {
        assignee: { team: "Finance" },
        details: { invoice: "A-1" },
        until: "2030-01-01T00:01:00.000Z",
      }),
    ).rejects.toThrow("process.exit 0");
    expect(writeSyncMock).toHaveBeenLastCalledWith(
      1,
      `${JSON.stringify({
        $swizzle: {
          suspend: {
            approval: true,
            assignee: { team: "Finance" },
            details: { invoice: "A-1" },
            reason: "event",
            stepKey: "approval-miss",
            until: "2030-01-01T00:01:00.000Z",
          },
        },
      })}\n`,
    );
  });

  it("signs a link per step and kind with the run's link key", () => {
    vi.stubEnv("SWIZZLE_LINK_URL", "https://links.example.com/");
    vi.stubEnv("SWIZZLE_LINK_KEY", "run-key");
    vi.stubEnv("SWIZZLE_RUN_ID", "run-1");
    const sign = (message: string) =>
      createHmac("sha256", "run-key").update(message).digest("base64url");
    const step = Buffer.from("manager approval").toString("base64url");

    expect(getApprovalUrl("manager approval")).toBe(
      `https://links.example.com/approvals/run-1.${step}.${sign("approval\nmanager approval")}`,
    );
    expect(getEventCallbackUrl("manager approval")).toBe(
      `https://links.example.com/events/run-1.${step}.${sign("event\nmanager approval")}`,
    );
    vi.stubEnv("SWIZZLE_LINK_KEY", undefined);
    expect(() => getApprovalUrl("manager approval")).toThrow("SWIZZLE_LINK_KEY");
  });
});

describe("durable step helpers", () => {
  // A step under a claim's name would answer claim() without asking the platform.
  it("refuses a step named like a claim", async () => {
    const fn = vi.fn(() => ({ claimed: true }));
    await expect(runStep("claim:order:A-1001", fn)).rejects.toThrow(
      'Swizzle step names starting with "claim:" are reserved for claim().',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns snapshot hits without executing the function", async () => {
    const directory = await temporaryDirectory("swizzle-sdk-");
    const stepsPath = path.join(directory, "steps.json");
    await writeFile(stepsPath, JSON.stringify({ "snapshot-hit": { ok: true } }), "utf8");
    vi.stubEnv("SWIZZLE_STEPS_FILE", stepsPath);

    const fn = vi.fn(() => ({ ok: false }));
    await expect(runStep("snapshot-hit", fn)).resolves.toEqual({ ok: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it("executes misses, emits results, and caches duplicate calls in-process", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const fn = vi.fn(() => ({ count: 1 }));

    await expect(runStep("miss-step", fn)).resolves.toEqual({ count: 1 });
    await expect(runStep("miss-step", () => ({ count: 2 }))).resolves.toEqual({ count: 1 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(writes.map((entry) => JSON.parse(entry))).toEqual([
      { key: "miss-step", type: "step_start" },
      { key: "miss-step", type: "step_result", value: { count: 1 } },
    ]);
  });

  // JSON.stringify turns a Date into a string, a Map or Set into {} and drops an undefined field,
  // so a replayed step would return another value than the run saw.
  it.each([
    [
      "a Date",
      new Date(0),
      'Swizzle step "lossy-step" result is not JSON: a Date at "when" has no JSON form.',
      "when",
    ],
    [
      "a Map",
      new Map([["a", 1]]),
      'Swizzle step "lossy-step" result is not JSON: a Map at "when" has no JSON form.',
      "when",
    ],
    [
      "a Set",
      new Set([1]),
      'Swizzle step "lossy-step" result is not JSON: a Set at "when" has no JSON form.',
      "when",
    ],
    [
      "an undefined field",
      undefined,
      'Swizzle step "lossy-step" result is not JSON: undefined at "when" has no JSON form.',
      "when",
    ],
  ])("fails a step whose result holds %s", async (_name, lossy, message, field) => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await expect(runStep("lossy-step", () => ({ [field]: lossy }))).rejects.toThrow(message);
    expect(writes.map((entry) => JSON.parse(entry))).toEqual([
      { key: "lossy-step", type: "step_start" },
    ]);
  });

  it("propagates thrown step failures and emits only the start", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await expect(
      runStep("throwing-step", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(writes.map((entry) => JSON.parse(entry))).toEqual([
      { key: "throwing-step", type: "step_start" },
    ]);
  });
});

describe("state helpers", () => {
  it("reads the injected state file and emits durable state events", async () => {
    const directory = await temporaryDirectory("swizzle-sdk-");
    const statePath = path.join(directory, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        cursor: "abc",
      }),
      "utf8",
    );
    vi.stubEnv("SWIZZLE_STATE_FILE", statePath);

    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await expect(stateGet("cursor")).resolves.toBe("abc");
    await expect(stateGet("missing", "fallback")).resolves.toBe("fallback");

    stateSet("cursor", { next: "def" });
    stateDelete("cursor");

    expect(writes.map((entry) => JSON.parse(entry))).toEqual([
      { key: "cursor", type: "state_set", value: { next: "def" } },
      { key: "cursor", type: "state_delete" },
    ]);
  });
});

// The values below pass a type check and a first look, but serialization would read them again
// or let a method rewrite them, so what was validated is not what is stored.
const hiddenRewrites: [string, () => unknown, string][] = [
  [
    "a toJSON method",
    () => Object.defineProperty({ x: 1 }, "toJSON", { value: () => "changed" }),
    'a toJSON method at "toJSON"',
  ],
  [
    "a toJSON method on an array",
    () => Object.defineProperty([1], "toJSON", { value: () => "changed" }),
    'a toJSON method at "toJSON"',
  ],
  [
    "a getter",
    () => {
      let reads = 0;
      return {
        get ratio() {
          reads += 1;
          return reads % 2 === 1 ? Number.NaN : 1;
        },
      };
    },
    'a getter at "ratio"',
  ],
  [
    "a sparse array",
    () => {
      const items = [1, 2, 3];
      delete items[1];
      return items;
    },
    'a hole at "1"',
  ],
  [
    "a cycle",
    () => {
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      return loop;
    },
    'a cycle at "self"',
  ],
];

describe.each(hiddenRewrites)("a value with %s", (_name, build, found) => {
  it("is refused as a state value", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => stateSet("hidden", build())).toThrow(
      `Swizzle state value "hidden" is not JSON: ${found} has no JSON form.`,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("is refused as a step result", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runStep(`hidden-${_name}`, build)).rejects.toThrow(
      `Swizzle step "hidden-${_name}" result is not JSON: ${found} has no JSON form.`,
    );
  });
});

describe("state values", () => {
  it("refuses a value JSON would change on the way back", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => stateSet("seen-at", { at: new Date(0) })).toThrow(
      'Swizzle state value "seen-at" is not JSON: a Date at "at" has no JSON form.',
    );
    expect(write).not.toHaveBeenCalled();
  });
});

describe("rate limit helpers", () => {
  it("records usage events and paces known limits", async () => {
    vi.stubEnv("SWIZZLE_RATE_LIMITS", JSON.stringify({ api: "20/sec" }));
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    recordRateLimitUsage("api", 2);
    vi.useFakeTimers();
    await pace("api");
    let paced = false;
    const second = pace("api").then(() => {
      paced = true;
    });
    // 20 calls a second leave 50 ms between two calls.
    await vi.advanceTimersByTimeAsync(49);
    expect(paced).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(paced).toBe(true);
    expect(JSON.parse(writes[0] ?? "{}")).toMatchObject({
      count: 2,
      group: "api",
      type: "rate_limit_usage",
    });
  });

  it("warns once and no-ops when pacing an unknown limit", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await pace("missing");
    await pace("missing");

    expect(writes.map((entry) => JSON.parse(entry))).toEqual([
      expect.objectContaining({
        name: "missing",
        type: "pace_unknown_rate_limit",
      }),
    ]);
  });
});

describe("connection helpers", () => {
  it("reads the injected connection access token and expiry", () => {
    vi.stubEnv("SWIZZLE_CONNECTION_GOOGLE_MAIN", "access-token");
    vi.stubEnv("SWIZZLE_CONNECTION_GOOGLE_MAIN_EXPIRES_AT", "2030-01-01T00:00:00.000Z");
    expect(getConnectionToken("google-main")).toBe("access-token");
    expect(getConnectionTokenExpiry("google-main")).toBe("2030-01-01T00:00:00.000Z");
  });

  it("throws a clear error when the connection was not injected", () => {
    expect(() => getConnectionToken("google-main")).toThrowError(/not available/);
    expect(getConnectionTokenExpiry("google-main")).toBeNull();
  });
});

describe("webhook helpers", () => {
  it("reads webhook headers, raw body bytes, and verifies HMAC signatures", async () => {
    const directory = await temporaryDirectory("swizzle-sdk-");
    const rawBody = Buffer.from('{\n  "hello": "world"\n}');
    const rawBodyPath = path.join(directory, "raw-body.bin");
    await writeFile(rawBodyPath, rawBody);

    vi.stubEnv("SWIZZLE_WEBHOOK_HEADERS", JSON.stringify({ "stripe-signature": "t=123,v1=abc" }));
    vi.stubEnv("SWIZZLE_WEBHOOK_RAW_BODY_PATH", rawBodyPath);

    const signature = `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`;

    expect(getWebhookHeaders()).toEqual({ "stripe-signature": "t=123,v1=abc" });
    await expect(getRawBody()).resolves.toEqual(rawBody);
    await expect(verifyHmac({ prefix: "sha256=", secret: "secret", signature })).resolves.toBe(
      true,
    );
    await expect(verifyHmac({ prefix: "sha256=", secret: "wrong", signature })).resolves.toBe(
      false,
    );
  });
});

describe("apiFetch", () => {
  const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it("names the API that answered when a redirect moves to another host", async () => {
    const successor = createServer((_request, response) => {
      response.writeHead(200, { sunset: "Thu, 31 Dec 2026 23:59:59 GMT" }).end("{}");
    });
    const successorHost = await listen(successor);
    const legacy = createServer((_request, response) => {
      response.writeHead(302, { location: `http://${successorHost}/v2/deals` }).end();
    });
    const legacyHost = await listen(legacy);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const response = await apiFetch(`http://${legacyHost}/v1/deals?page=2`);

      expect(response.status).toBe(200);
      const events = stderr.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(events).toMatchObject([
        {
          host: successorHost,
          path: "/v2/deals",
          status: 200,
          sunset: "Thu, 31 Dec 2026 23:59:59 GMT",
          type: "api_contact",
        },
      ]);
    } finally {
      stderr.mockRestore();
      legacy.close();
      successor.close();
    }
  });
});

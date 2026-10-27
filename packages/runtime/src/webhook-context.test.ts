import { describe, expect, it } from "vitest";

import { createWebhookRunContext } from "./webhook-context.js";

const rawBody = Buffer.from('{"hello":"world"}');

describe("createWebhookRunContext", () => {
  it("forwards provider headers the platform has never heard of", () => {
    const context = createWebhookRunContext({
      headers: {
        "close-sig-hash": "abc123",
        "close-sig-timestamp": "1700000000",
        "content-type": "application/json",
        "x-vendor-that-does-not-exist-yet": "whatever",
      },
      rawBody,
    });

    expect(context.headers).toEqual({
      "close-sig-hash": "abc123",
      "close-sig-timestamp": "1700000000",
      "content-type": "application/json",
      "x-vendor-that-does-not-exist-yet": "whatever",
    });
  });

  // The security invariant: forwarding a webhook must never hand automation code an
  // Swizzle credential. Everything else about header forwarding is convenience.
  it("never forwards the platform's own credential headers", () => {
    const context = createWebhookRunContext({
      headers: {
        Authorization: "Bearer platform-token",
        Cookie: "swizzle.session_token=platform-session",
        "Proxy-Authorization": "Basic cGxhdGZvcm0=",
        "x-hub-signature-256": "sha256=def",
      },
      rawBody,
    });

    expect(context.headers).toEqual({ "x-hub-signature-256": "sha256=def" });
  });

  it("lower-cases header names and joins repeated values", () => {
    const context = createWebhookRunContext({
      headers: {
        "Close-Sig-Hash": "abc123",
        "set-cookie": ["a=1", "b=2"],
        "x-empty": undefined,
      },
      rawBody,
    });

    expect(context.headers).toEqual({
      "close-sig-hash": "abc123",
      "set-cookie": "a=1, b=2",
    });
  });
});

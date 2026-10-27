import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { APPROVAL_PAGE_CSP, approvalPage, messagePage } from "./approval-page.js";

const wait = {
  automationName: "refunds",
  details: { amount: 120, customer: { name: "Ada" }, message: "Refund 120 € for order 4411?" },
  expiresAt: "2026-11-02T17:18:49.847Z",
  runId: "run-1",
  stepKey: "gate",
};

describe("the public approval page", () => {
  it("reads the details as words and the deadline as a time the browser localizes", () => {
    const html = approvalPage({ wait });

    expect(html).toContain("<h1>Refund 120 € for order 4411?</h1>");
    expect(html).toContain("<dt>amount</dt><dd>120</dd>");
    expect(html).toContain(
      '<dt>customer</dt><dd class="mono">{&quot;name&quot;:&quot;Ada&quot;}</dd>',
    );
    expect(html).not.toContain("<pre>");
    expect(html).toContain(
      '<time datetime="2026-11-02T17:18:49.847Z">2 Nov 2026, 17:18 UTC</time>',
    );
  });

  it("follows the visitor's colour scheme and carries the Swizzle logo", () => {
    for (const html of [
      approvalPage({ wait: { ...wait, details: "Ship it?" } }),
      messagePage({ heading: "No longer open", message: "The link no longer works." }),
    ]) {
      expect(html).toContain("color-scheme: light dark");
      expect(html).toContain("@media (prefers-color-scheme: dark)");
      expect(html).toContain(
        '<svg class="logo" viewBox="34 -2 624 148" role="img" aria-label="Swizzle">',
      );
    }
  });

  it("posts the decision to the address it was opened at, on any origin and path", () => {
    const html = approvalPage({ wait });

    expect(html).toContain('<form method="post">');
  });

  it("runs no script on a page without a deadline, so any origin's policy shows it whole", () => {
    const html = messagePage({ heading: "<b>Not</b> found", message: "Ask & retry." });

    expect(html).not.toContain("<script>");
    expect(html).toContain("<h1>&lt;b&gt;Not&lt;/b&gt; found</h1>");
    expect(html).toContain('<p class="meta">Ask &amp; retry.</p>');
  });

  it("allows exactly its own script", () => {
    const html = approvalPage({ wait });
    const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1] ?? "";
    const hash = createHash("sha256").update(script).digest("base64");
    expect(APPROVAL_PAGE_CSP).toContain(`script-src 'sha256-${hash}'`);
  });
});

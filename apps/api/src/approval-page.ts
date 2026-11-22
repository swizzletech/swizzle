import { createHash } from "node:crypto";
import { approvalDetailsInWords } from "@swizzle/config";
import { redactWaitLinks } from "@swizzle/runtime";

import type { OpenWaitRecord } from "@swizzle/runtime/platform";
import { APPROVAL_LOGO } from "./approval-logo.js";

const STYLE = `
:root {
  color-scheme: light dark;
  --coral: #ff8b61;
  --bg: #fcfcfc; --surface: #ffffff; --raised: #ffffff; --surface-2: #f4f4f5;
  --ink: #18181b; --ink-2: #3f3f46; --ink-3: #71717a;
  --line: #e4e4e7; --line-2: #d4d4d8;
  --primary: #18181b; --primary-ink: #fafafa; --fail: #ef4444; --fail-text: #b91c1c; --tint: 8%;
  --ring: color-mix(in srgb, var(--coral) 75%, var(--ink));
  --shadow-xs: 0 1px 2px rgb(0 0 0 / 0.04);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0a; --surface: #111111; --raised: #151515; --surface-2: #1b1b1b;
    --ink: #f5f5f5; --ink-2: #d4d4d4; --ink-3: #a3a3a3;
    --line: rgb(255 255 255 / 0.08); --line-2: rgb(255 255 255 / 0.12);
    --primary: #f5f5f5; --primary-ink: #0a0a0a; --fail: #f05252; --fail-text: #f87171; --tint: 16%;
    --shadow-xs: 0 0 #0000;
  }
}
:root { --tint-fail: color-mix(in srgb, var(--fail) var(--tint), var(--surface)); }
html, body { margin: 0; background: var(--bg); }
body {
  display: grid; place-items: center; min-height: 100vh; padding: 48px 16px; box-sizing: border-box;
  color: var(--ink);
  font: 400 14px / 1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.frame { width: 100%; max-width: 460px; }
.logo { display: block; height: 28px; width: auto; margin-bottom: 20px; }
.logo-edge { display: none; }
@media (prefers-color-scheme: dark) { .logo-edge { display: inline; } }
main { padding: 28px 32px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow-xs); }
.label { margin: 0 0 6px; color: var(--ink-3); font-weight: 500; font-size: 12px; }
h1 { margin: 0; font-weight: 600; font-size: 20px; line-height: 1.25; letter-spacing: -0.015em; overflow-wrap: anywhere; }
.meta { margin: 6px 0 0; color: var(--ink-3); font-size: 13px; }
dl { display: grid; grid-template-columns: fit-content(40%) minmax(0, 1fr); gap: 6px 16px; margin: 18px 0 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; font-size: 13px; }
dt { color: var(--ink-3); overflow-wrap: anywhere; }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
form { display: grid; gap: 6px; margin-top: 20px; }
label { color: var(--ink-2); font-weight: 500; font-size: 13px; }
textarea { box-sizing: border-box; width: 100%; min-height: 88px; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--raised); color: var(--ink); font: inherit; font-size: 13px; box-shadow: var(--shadow-xs); }
.actions { display: flex; gap: 8px; margin-top: 10px; }
button { height: 32px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--primary); color: var(--primary-ink); font: inherit; font-weight: 500; font-size: 13px; cursor: pointer; box-shadow: inset 0 1px rgb(255 255 255 / 0.16), var(--shadow-xs); }
button:hover { background: color-mix(in srgb, var(--primary) 88%, var(--bg)); }
button[value="reject"] { background: var(--raised); color: var(--fail-text); box-shadow: inset 0 0 0 1px var(--line-2), var(--shadow-xs); }
button[value="reject"]:hover { background: var(--tint-fail); }
.foot { margin: 16px 0 0; color: var(--ink-3); font-size: 12px; text-align: center; }
`;

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZoneName: "short",
  year: "numeric",
};

const LOCAL_TIME_SCRIPT = `for (const time of document.querySelectorAll("time[datetime]")) time.textContent = new Date(time.dateTime).toLocaleString(undefined, ${JSON.stringify(TIME_FORMAT)});`;

export const APPROVAL_PAGE_CSP = `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256").update(LOCAL_TIME_SCRIPT).digest("base64")}'`;

export const MAX_COMMENT_LENGTH = 2_000;

export function approvalPage(input: {
  readonly wait: Pick<OpenWaitRecord, "automationName" | "details" | "expiresAt" | "stepKey">;
}): string {
  const { wait } = input;
  const { heading, fields } = approvalDetailsInWords(wait.details);
  const detailHtml = (value: string) => escapeHtml(redactWaitLinks(value));
  return page(
    "Approval requested",
    `<p class="label">${escapeHtml(wait.automationName)} · approval ${escapeHtml(wait.stepKey)}</p>
  <h1>${detailHtml(heading ?? "Approve this step?")}</h1>
  <p class="meta">Open until ${timeHtml(wait.expiresAt)}</p>
  ${
    fields.length === 0
      ? ""
      : `<dl>${fields.map((field) => `<dt>${detailHtml(field.label)}</dt><dd${field.json ? ' class="mono"' : ""}>${detailHtml(field.value)}</dd>`).join("")}</dl>`
  }
  <form method="post">
    <label for="comment">Comment (optional)</label>
    <textarea id="comment" name="comment" maxlength="${MAX_COMMENT_LENGTH}"></textarea>
    <div class="actions">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="reject">Reject</button>
    </div>
  </form>
  <script>${LOCAL_TIME_SCRIPT}</script>`,
  );
}

export function messagePage(input: { readonly heading: string; readonly message: string }): string {
  return page(
    input.heading,
    `<h1>${escapeHtml(input.heading)}</h1>
  <p class="meta">${escapeHtml(input.message)}</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Swizzle</title>
<style>${STYLE}</style>
</head>
<body>
<div class="frame">
  ${APPROVAL_LOGO}
  <main>
  ${body}
  </main>
  <p class="foot">Agents write it. Swizzle runs it.</p>
</div>
</body>
</html>`;
}

function timeHtml(iso: string): string {
  const utc = new Intl.DateTimeFormat("en-GB", { ...TIME_FORMAT, timeZone: "UTC" }).format(
    new Date(iso),
  );
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(utc)}</time>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

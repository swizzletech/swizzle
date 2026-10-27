// The HTML pages the API serves to a browser itself: the public approval link (approval-routes.ts),
// the page that asks for a decision and the one-line pages for every other answer, and the OAuth
// connection callback (connection-routes.ts), which reuses the one-line page. They look like the
// dashboard's sign-in screen (the mark above one card, light or dark by the visitor's system) but
// run on the links and API origins, which serve no dashboard assets, so they carry their own copy
// of the tokens they use from apps/web/src/styles.css. Only the approval page runs a script, one
// inline script that shows the deadline in the visitor's time zone; APPROVAL_PAGE_CSP allows
// exactly that script. Every page works on any origin and path that serves it.

import { createHash } from "node:crypto";
import { redactWaitLinks } from "@swizzle/runtime";

import type { OpenWaitRecord } from "@swizzle/runtime/platform";

const STYLE = `
:root {
  color-scheme: light dark;
  --coral: #ff8b61; --peach: #ffd8bd;
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
.brand { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 20px; font-weight: 600; font-size: 15px; letter-spacing: -0.01em; }
.mark { width: 20px; height: 20px; flex: none; }
.mark .a1 { stroke: var(--coral); }
.mark .a2 { stroke: var(--peach); }
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

// The same arcs as Mark in apps/web/src/components/ui.tsx.
const MARK = `<svg aria-hidden="true" class="mark" fill="none" viewBox="0 0 24 24"><path class="a1" d="M24 24A20 20 0 0 1 4 4" stroke-width="4.2"/><path class="a2" d="M24 24A13 13 0 0 1 11 11" stroke-width="4.2"/><path class="a1" d="M24 24A6 6 0 0 1 18 18" stroke-width="4.2"/></svg>`;

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZoneName: "short",
  year: "numeric",
};

// Rewrites each <time> in the visitor's language and time zone; without scripts the UTC text stays.
const LOCAL_TIME_SCRIPT = `for (const time of document.querySelectorAll("time[datetime]")) time.textContent = new Date(time.dateTime).toLocaleString(undefined, ${JSON.stringify(TIME_FORMAT)});`;

/** The API's policy for these pages, plus the one script they run. */
export const APPROVAL_PAGE_CSP = `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256").update(LOCAL_TIME_SCRIPT).digest("base64")}'`;

export const MAX_COMMENT_LENGTH = 2_000;

/**
 * The page that asks the link holder to approve or reject one waiting step. Its form has no action,
 * so it posts back to the address that served it, behind whichever origin or proxy path that was.
 */
export function approvalPage(input: {
  readonly wait: Pick<OpenWaitRecord, "automationName" | "details" | "expiresAt" | "stepKey">;
}): string {
  const { wait } = input;
  // The holder decides one step; its details must not hand them another step's link.
  const { lead, facts } = detailsInWords(wait.details);
  const detailHtml = (value: string) => escapeHtml(redactWaitLinks(value));
  return page(
    "Approval requested",
    `<p class="label">${escapeHtml(wait.automationName)} · approval ${escapeHtml(wait.stepKey)}</p>
  <h1>${detailHtml(lead ?? "Approve this step?")}</h1>
  <p class="meta">Open until ${timeHtml(wait.expiresAt)}</p>
  ${
    facts.length === 0
      ? ""
      : `<dl>${facts.map(([key, value, mono]) => `<dt>${detailHtml(key)}</dt><dd${mono ? ' class="mono"' : ""}>${detailHtml(value)}</dd>`).join("")}</dl>`
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

/**
 * Every other answer of the link (decided, closed, assigned, not found, too many requests) and the
 * OAuth callback's answer. It runs no script, so the API's base policy shows it whole.
 */
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
  <span class="brand">${MARK}swizzle</span>
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

/**
 * What an automation passed as details, as words: a string, or an object's message, question,
 * summary or title, is the heading (as the dashboard's approval card reads it); the other fields
 * become labelled lines, nested values in compact JSON.
 */
function detailsInWords(details: unknown): {
  readonly lead: string | null;
  readonly facts: readonly (readonly [string, string, boolean])[];
} {
  if (details === null || details === undefined) return { facts: [], lead: null };
  if (typeof details === "string") return { facts: [], lead: details };
  if (typeof details !== "object" || Array.isArray(details))
    return { facts: [["Details", JSON.stringify(details), true]], lead: null };
  const record = details as Record<string, unknown>;
  const leadKey = ["message", "question", "summary", "title"].find(
    (key) => typeof record[key] === "string" && record[key] !== "",
  );
  const facts = Object.entries(record)
    .filter(([key]) => key !== leadKey)
    .map(([key, value]): readonly [string, string, boolean] =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [key, String(value), false]
        : [key, JSON.stringify(value), true],
    );
  return { facts, lead: leadKey === undefined ? null : (record[leadKey] as string) };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

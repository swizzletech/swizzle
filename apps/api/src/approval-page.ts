// The HTML pages the API serves to a browser itself: the public approval link (approval-routes.ts),
// the page that asks for a decision and the one-line pages for every other answer, and the OAuth
// connection callback (connection-routes.ts), which reuses the one-line page. They look like the
// dashboard's sign-in screen (the logo above one card, light or dark by the visitor's system) but
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

// The same drawing as Logo in apps/web/src/components/logo.tsx and docs/assets/logo-dark.svg: the
// head and the outlined wordmark over a creme edge that only dark mode shows.
const LOGO = `<svg class="logo" viewBox="34 -2 624 148" role="img" aria-label="Swizzle"><defs><path id="swizzle-word" d="M248.6 119.68Q240.04 119.68 232.79 118Q225.53 116.33 221.19 112.67Q216.85 109.01 216.85 102.94Q216.85 97.6 220.08 94.13Q223.3 90.66 228.63 90.66Q231.98 90.66 235.39 91.71Q238.8 92.77 242.64 93.76Q246.49 94.75 250.95 94.75Q254.92 94.75 256.28 94.32Q257.65 93.88 257.65 92.64Q257.65 91.16 255.97 90.66Q254.3 90.16 250.33 89.42L241.4 87.68Q235.82 86.57 230.55 84.77Q225.28 82.97 221.87 79.38Q218.46 75.78 218.46 69.58Q218.46 61.15 225.97 56.44Q233.47 51.72 247.73 51.72Q255.91 51.72 262.42 53.34Q268.93 54.95 272.78 58.11Q276.62 61.27 276.62 65.98Q276.74 71.07 273.89 74.17Q271.04 77.27 266.7 77.27Q263.6 77.27 260.44 76.46Q257.28 75.66 253.62 74.73Q249.96 73.8 245.25 73.67Q241.9 73.42 239.79 74.04Q237.68 74.66 237.68 76.03Q237.68 77.52 240.16 78.07Q242.64 78.63 247.6 79.5L256.41 81.11Q264.47 82.48 269.24 84.52Q274.02 86.57 276.12 90.16Q278.23 93.76 278.23 100.08Q278.23 106.66 274.45 111.06Q270.67 115.46 263.97 117.57Q257.28 119.68 248.6 119.68ZM310.47 118.06Q303.28 118.06 298.75 113.35Q294.23 108.64 290.51 97.85L281.08 69.83Q279.47 65.12 280.96 60.28Q282.45 55.44 287.78 53.71Q292.74 51.97 296.83 53.96Q300.92 55.94 302.54 60.78L312.7 91.16Q314.44 96.49 316.3 98.29Q318.16 100.08 321.26 99.09Q323.86 98.22 324.55 95.31Q325.23 92.4 322.75 85.2L317.66 69.83Q316.05 64.99 317.6 60.22Q319.15 55.44 324.48 53.71Q329.44 51.97 333.54 53.96Q337.63 55.94 339.24 60.78L349.66 92.52Q350.65 95.37 352.76 97.73Q354.86 100.08 358.21 99.09Q360.82 98.22 361.62 95.62Q362.43 93.02 361.31 89.54Q359.82 84.83 358.03 82.1Q356.23 79.38 354.55 77.39Q352.88 75.41 351.83 73.18Q350.77 70.94 350.52 67.1Q350.28 63.13 352.2 60.09Q354.12 57.06 357.41 55.32Q360.69 53.58 364.66 53.58Q370.74 53.58 374.52 57.61Q378.3 61.64 378.3 67.1Q378.3 69.08 377.68 72.31Q377.06 75.53 376.07 78.26L370.86 91.78Q369.25 96.24 367.2 100.89Q365.16 105.54 362.49 109.38Q359.82 113.23 356.35 115.65Q352.88 118.06 348.29 118.06Q340.36 118.06 335.58 113.97Q330.81 109.88 328.08 100.46L326.84 100.46Q325.23 108.14 321.51 113.1Q317.79 118.06 310.47 118.06ZM382.89 38.83Q382.89 33.5 386.17 30.21Q389.46 26.92 395.29 26.92Q401.49 26.92 404.53 30.15Q407.56 33.37 407.56 38.7Q407.56 43.91 404.53 47.07Q401.49 50.24 395.29 50.24Q389.21 50.24 386.05 47.07Q382.89 43.91 382.89 38.83ZM395.29 118.06Q389.46 118.06 386.61 114.84Q383.76 111.62 383.76 106.78L383.76 64.37Q383.76 59.04 386.61 55.94Q389.46 52.84 395.29 52.84Q401.12 52.84 404.03 55.94Q406.94 59.04 406.94 64.12L406.94 106.78Q406.94 111.62 403.91 114.84Q400.87 118.06 395.29 118.06ZM429.64 118.06Q421.82 118.06 416.99 114.22Q412.15 110.38 412.15 103.68Q412.15 96.86 415.62 93.51Q419.1 90.16 423.19 88.68L451.83 78.01L451.83 77.52L426.66 77.52Q421.08 77.52 417.42 74.48Q413.76 71.44 413.76 65.36Q413.76 59.16 417.42 56.19Q421.08 53.21 426.66 53.21L457.04 53.21Q462.99 53.21 467.15 56.06Q471.3 58.92 471.3 66.23Q471.3 71.81 467.89 75.66Q464.48 79.5 458.03 81.98L434.47 90.91L434.47 91.4L459.77 91.4Q465.84 91.4 469.81 94.75Q473.78 98.1 473.78 104.8Q473.78 111.62 469.81 114.84Q465.84 118.06 459.77 118.06ZM494.86 118.06Q487.05 118.06 482.21 114.22Q477.38 110.38 477.38 103.68Q477.38 96.86 480.85 93.51Q484.32 90.16 488.41 88.68L517.06 78.01L517.06 77.52L491.88 77.52Q486.3 77.52 482.65 74.48Q478.99 71.44 478.99 65.36Q478.99 59.16 482.65 56.19Q486.3 53.21 491.88 53.21L522.26 53.21Q528.22 53.21 532.37 56.06Q536.52 58.92 536.52 66.23Q536.52 71.81 533.11 75.66Q529.7 79.5 523.26 81.98L499.7 90.91L499.7 91.4L524.99 91.4Q531.07 91.4 535.04 94.75Q539 98.1 539 104.8Q539 111.62 535.04 114.84Q531.07 118.06 524.99 118.06ZM555.87 118.06Q549.79 118.06 546.75 114.84Q543.72 111.62 543.72 106.78L543.72 34.86Q543.72 29.53 546.75 25.99Q549.79 22.46 555.87 22.46Q561.32 22.46 564.3 25.99Q567.28 29.53 567.28 34.61L567.28 106.78Q567.28 111.62 564.3 114.84Q561.32 118.06 555.87 118.06ZM572.98 85.82Q572.98 76.03 576.89 68.59Q580.79 61.15 588.05 56.93Q595.3 52.72 605.34 52.72Q613.16 52.72 619.42 55.57Q625.68 58.42 629.28 63.19Q632.87 67.97 632.87 73.67Q632.87 79.62 629.4 82.1Q625.93 84.58 619.11 84.58L593.07 84.58Q593.07 87.81 595.61 89.92Q598.15 92.02 604.23 92.02Q607.33 92.02 609.99 91.4Q612.66 90.78 615.45 90.23Q618.24 89.67 621.71 89.67Q626.67 89.67 629.9 93.2Q633.12 96.74 633.12 102.94Q633.12 110.25 625.62 114.34Q618.12 118.44 605.96 118.44Q597.41 118.44 589.91 115.09Q582.4 111.74 577.69 104.49Q572.98 97.23 572.98 85.82ZM613.16 80.49Q615.02 80.49 614.4 78.76Q613.9 77.02 611.42 75.16Q608.94 73.3 604.23 73.3Q598.77 73.3 596.11 75.66Q593.44 78.01 593.44 80.49Z"/></defs><g class="logo-edge" fill="#FEFEEF" stroke="#FEFEEF" stroke-linejoin="round" stroke-linecap="round"><path d="M102 22 C102 2 126 2 124 16 C123 24 112 22 114 15" fill="none" stroke-width="15"/><circle cx="102" cy="78" r="58" stroke-width="14.5"/><use href="#swizzle-word" x="18" y="18" stroke-width="10"/><use href="#swizzle-word" x="14" y="14" stroke-width="10"/><use href="#swizzle-word" x="8" y="8" stroke-width="10"/><use href="#swizzle-word" x="0" y="0" stroke-width="16.4"/></g><g stroke-width="6.4" stroke-linejoin="round"><use href="#swizzle-word" x="18" y="18" fill="#2A1712"/><use href="#swizzle-word" x="14" y="14" fill="#F2AE3D"/><use href="#swizzle-word" x="8" y="8" fill="#2A1712"/><use href="#swizzle-word" fill="#FF8B61" stroke="#2A1712" paint-order="stroke"/></g><path d="M102 22 C102 2 126 2 124 16 C123 24 112 22 114 15" fill="none" stroke="#2A1712" stroke-width="5" stroke-linecap="round"/><circle cx="102" cy="78" r="58" fill="#FF8B61" stroke="#2A1712" stroke-width="4.5"/><circle cx="99" cy="81" r="45" fill="#FFD8BD"/><circle cx="97" cy="83" r="33" fill="#FEFEEF" stroke="#2A1712" stroke-width="3"/><ellipse cx="86" cy="76" rx="6" ry="9.5" fill="#2A1712"/><ellipse cx="109" cy="76" rx="6" ry="9.5" fill="#2A1712"/><circle cx="88" cy="72" r="2.4" fill="#FEFEEF"/><circle cx="111" cy="72" r="2.4" fill="#FEFEEF"/><ellipse cx="76" cy="92" rx="6" ry="4" fill="#FF8B61" opacity=".7"/><ellipse cx="119" cy="92" rx="6" ry="4" fill="#FF8B61" opacity=".7"/><path d="M86 91 Q98 108 110 91 Z" fill="#2A1712" stroke="#2A1712" stroke-width="2.5" stroke-linejoin="round"/><path d="M93 99 Q98 95 104 99 Q98 103 93 99 Z" fill="#FF8B61"/></svg>`;

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
  ${LOGO}
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

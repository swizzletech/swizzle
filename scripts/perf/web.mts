// The frontend half of `just perf`: load metrics and bundle bytes of each main dashboard page, and
// the main-thread cost of the main interactions, in Chromium under a fixed CPU and network
// profile. Every measurement opens a fresh browser context, so each load starts from a cold cache.

/// <reference lib="dom" />

import { type Browser, chromium, type Page } from "@playwright/test";
import type { PackagedStack } from "../packaged-stack.mts";
import { API_PROFILE } from "./api.mts";
import { quantile, Rounds } from "./result.ts";

/** The fixed scenario; perf.mts records it in the result, so a change makes runs incomparable. */
export const WEB_PROFILE = {
  cpuThrottle: 4,
  downloadKbps: 10_240,
  networkLatencyMs: 40,
  settleMs: 1_000,
  uploadKbps: 5_120,
  viewport: "1280x720",
} as const;

// Credentials and Settings replace the Secrets, Connections and Alerting pages of dashboards
// before the rebuild. Measured against such a base, those two rows load its not-found page.
const PAGES = [
  "/",
  `/automations/${API_PROFILE.referenceAutomation}`,
  "/runs",
  "/credentials",
  "/settings/agent-access",
] as const;

interface Interaction {
  readonly name: string;
  readonly start: string;
  /** Does what the user does and resolves when the result is on screen. */
  act(page: Page): Promise<void>;
}

const INTERACTIONS: readonly Interaction[] = [
  {
    act: async (page) => {
      await page
        .locator(`a[href="/automations/${API_PROFILE.referenceAutomation}"]`)
        .first()
        .click();
      await page.waitForURL(`**/automations/${API_PROFILE.referenceAutomation}`);
    },
    name: "open automation from home",
    start: "/",
  },
  {
    act: async (page) => {
      await page.locator('a[href="/runs"]').first().click();
      await page.waitForURL("**/runs");
    },
    name: "navigate to runs",
    start: "/",
  },
  {
    act: async (page) => {
      // Run rows are buttons whose name holds the automation, the run id and the trigger type.
      await page
        .getByRole("button", { name: /· webhook/u })
        .nth(1)
        .click();
      await page.waitForURL(/selected=/u);
    },
    name: "select a run",
    start: "/runs",
  },
];

/**
 * Runs in the page before its own scripts: buffers the entries the metrics are computed from.
 * `mark` starts an interaction; frames and entries before it belong to the load.
 */
function observe(): void {
  const state = {
    events: [] as { start: number; duration: number }[],
    fcp: 0,
    frames: [] as number[],
    lcp: 0,
    longTasks: [] as { start: number; duration: number }[],
    shifts: [] as { start: number; value: number }[],
  };
  Object.assign(window, { __perf: state });
  const watch = (type: string, handle: (entry: PerformanceEntry) => void, options = {}) =>
    new PerformanceObserver((list) => list.getEntries().forEach(handle)).observe({
      buffered: true,
      type,
      ...options,
    });
  watch("paint", (entry) => {
    if (entry.name === "first-contentful-paint") state.fcp = entry.startTime;
  });
  watch("largest-contentful-paint", (entry) => {
    state.lcp = entry.startTime;
  });
  watch("layout-shift", (entry) => {
    const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
    if (!shift.hadRecentInput) state.shifts.push({ start: shift.startTime, value: shift.value });
  });
  watch("longtask", (entry) => {
    state.longTasks.push({ duration: entry.duration, start: entry.startTime });
  });
  watch(
    "event",
    (entry) => {
      state.events.push({ duration: entry.duration, start: entry.startTime });
    },
    { durationThreshold: 16 },
  );
  const frame = (time: number) => {
    state.frames.push(time);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** What `observe` buffered, read back after the page settled. */
interface Observed {
  readonly events: readonly { start: number; duration: number }[];
  readonly fcp: number;
  readonly frames: readonly number[];
  readonly lcp: number;
  readonly longTasks: readonly { start: number; duration: number }[];
  readonly shifts: readonly { start: number; value: number }[];
  readonly resources: readonly { name: string; transferSize: number }[];
}

async function read(page: Page): Promise<Observed> {
  return await page.evaluate(() => ({
    ...(window as unknown as { __perf: Omit<Observed, "resources"> }).__perf,
    resources: performance.getEntriesByType("resource").map((entry) => ({
      name: entry.name,
      transferSize: (entry as PerformanceResourceTiming).transferSize,
    })),
  }));
}

/** Cumulative layout shift: the largest session window (gaps under 1 s, at most 5 s long). */
function cumulativeLayoutShift(shifts: Observed["shifts"]): number {
  let largest = 0;
  let current = 0;
  let first = Number.NEGATIVE_INFINITY;
  let previous = Number.NEGATIVE_INFINITY;
  for (const { start, value } of shifts) {
    if (start - previous > 1_000 || start - first > 5_000) {
      current = 0;
      first = start;
    }
    current += value;
    previous = start;
    largest = Math.max(largest, current);
  }
  return largest;
}

/** Main-thread time beyond 50 ms per long task: the share that blocks input. */
const blocking = (tasks: Observed["longTasks"]) =>
  tasks.reduce((total, task) => total + Math.max(0, task.duration - 50), 0);

const kibibytes = (resources: Observed["resources"], extension: RegExp) =>
  resources
    .filter((entry) => extension.test(new URL(entry.name).pathname))
    .reduce((total, entry) => total + entry.transferSize, 0) / 1024;

/** A page in a fresh context, logged in, throttled, loaded until it settles. */
async function open(browser: Browser, stack: PackagedStack, path: string): Promise<Page> {
  const [width, height] = WEB_PROFILE.viewport.split("x").map(Number);
  const context = await browser.newContext({
    viewport: { height: height ?? 720, width: width ?? 1280 },
  });
  await context.addCookies([{ ...stack.session, url: stack.dashboard }]);
  // tsx compiles with esbuild's keepNames, which wraps inner functions in a `__name` helper the
  // page lacks; the script defines it before it runs `observe`.
  await context.addInitScript({ content: `const __name = (f) => f; (${observe})();` });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: WEB_PROFILE.cpuThrottle });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    downloadThroughput: (WEB_PROFILE.downloadKbps * 1024) / 8,
    latency: WEB_PROFILE.networkLatencyMs,
    offline: false,
    uploadThroughput: (WEB_PROFILE.uploadKbps * 1024) / 8,
  });
  await page.goto(`${stack.dashboard}${path}`, { waitUntil: "load" });
  await settle(page);
  // Only the sign-in form asks for an email address, before and after the dashboard rebuild. A
  // page the dashboard lacks renders its not-found page, which still counts as signed in.
  if (await page.locator('input[autocomplete="email"]').isVisible()) {
    throw new Error(`${path} showed the sign-in form instead of the signed-in dashboard.`);
  }
  return page;
}

/** Waits until the network is quiet, then WEB_PROFILE.settleMs more for late work. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(WEB_PROFILE.settleMs);
}

async function measureLoad(browser: Browser, stack: PackagedStack, path: string, rounds: Rounds) {
  const page = await open(browser, stack, path);
  try {
    const observed = await read(page);
    const group = `page ${path}`;
    rounds.record(group, "FCP", "ms", "lower", observed.fcp);
    rounds.record(group, "LCP", "ms", "lower", observed.lcp);
    rounds.record(
      group,
      "TBT",
      "ms",
      "lower",
      blocking(observed.longTasks.filter((task) => task.start >= observed.fcp)),
    );
    rounds.record(group, "CLS", "score", "lower", cumulativeLayoutShift(observed.shifts));
    rounds.record(group, "long tasks", "count", "lower", observed.longTasks.length);
    rounds.record(group, "JS", "KiB", "lower", kibibytes(observed.resources, /\.m?js$/u));
    rounds.record(group, "CSS", "KiB", "lower", kibibytes(observed.resources, /\.css$/u));
  } finally {
    await page.context().close();
  }
}

async function measureInteraction(
  browser: Browser,
  stack: PackagedStack,
  interaction: Interaction,
  rounds: Rounds,
) {
  const page = await open(browser, stack, interaction.start);
  try {
    const mark = await page.evaluate(() => performance.now());
    await interaction.act(page);
    await settle(page);
    const observed = await read(page);
    const after = <T extends { start: number }>(entries: readonly T[]) =>
      entries.filter((entry) => entry.start >= mark);
    const frames = observed.frames.filter((time) => time >= mark);
    const intervals = frames.slice(1).map((time, index) => time - (frames[index] ?? time));
    const group = `interaction ${interaction.name}`;
    rounds.record(
      group,
      "INP",
      "ms",
      "lower",
      Math.max(0, ...after(observed.events).map((entry) => entry.duration)),
    );
    rounds.record(group, "TBT", "ms", "lower", blocking(after(observed.longTasks)));
    rounds.record(group, "long tasks", "count", "lower", after(observed.longTasks).length);
    rounds.record(
      group,
      "frame p95",
      "ms",
      "lower",
      intervals.length === 0 ? 0 : quantile(intervals, 0.95),
    );
    rounds.record(
      group,
      "frames >50ms",
      "count",
      "lower",
      intervals.filter((interval) => interval > 50).length,
    );
  } finally {
    await page.context().close();
  }
}

/** The browser every measurement opens its fresh context in. */
export const launchBrowser = (): Promise<Browser> => chromium.launch();

/** Loads every page once, unrecorded, so the stack's caches and JIT are warm. */
export async function warmWeb(browser: Browser, stack: PackagedStack): Promise<void> {
  for (const path of PAGES) await measureLoad(browser, stack, path, new Rounds());
}

/** One round: every page load and every interaction once, in turn. */
export async function webRound(
  browser: Browser,
  stack: PackagedStack,
  rounds: Rounds,
): Promise<void> {
  for (const path of PAGES) await measureLoad(browser, stack, path, rounds);
  for (const interaction of INTERACTIONS) {
    await measureInteraction(browser, stack, interaction, rounds);
  }
}

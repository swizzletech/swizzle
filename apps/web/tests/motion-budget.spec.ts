import { expect, type Page, test } from "@playwright/test";

import { mockDashboardApi, seededState } from "./dashboard-mock";

/*
 * A regression fence for one specific failure mode: an `infinite` CSS animation
 * keeps the page from ever going idle, so the compositor commits a frame at the
 * display refresh rate and re-pays for every expensive layer in each of them. A
 * dashboard people leave open all day turns that into sustained GPU load.
 *
 * These tests read what the browser actually resolved, so they hold regardless
 * of which utility class or stylesheet introduced the animation. They do not
 * see requestAnimationFrame loops, canvas, or video.
 */

/** Properties the compositor can animate without a main-thread repaint. */
const COMPOSITED_PROPERTIES = new Set(["opacity", "transform"]);

/**
 * Share of the cycle an animation must spend holding a value flat. Chromium
 * skips producing a frame while an animated value is unchanged, so the holds
 * are what makes a permanent animation affordable.
 */
const MINIMUM_FLAT_SHARE = 0.5;

/**
 * Stock Tailwind animations that legitimately run continuously: duty-cycling a
 * spinner reads as a stutter, not as motion. They stay affordable by only being
 * mounted while a transient state lasts, which is a rule about component
 * lifetime that no static assertion can see — so the property check below still
 * applies to them, only the flat-value requirement does not.
 */
const TRANSIENT_ANIMATIONS = new Set(["bounce", "spin"]);

interface RunawayAnimation {
  readonly flatShare: number;
  readonly name: string;
  readonly properties: readonly string[];
  readonly target: string;
}

async function collectInfiniteAnimations(page: Page): Promise<RunawayAnimation[]> {
  return await page.evaluate(() => {
    const metadata = new Set(["composite", "computedOffset", "easing", "offset"]);

    return document.getAnimations().flatMap((animation) => {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect)) return [];
      if (animation.playState !== "running") return [];
      if (effect.getTiming().iterations !== Number.POSITIVE_INFINITY) return [];

      const frames = effect.getKeyframes();
      const properties = [
        ...new Set(
          frames.flatMap((frame) => Object.keys(frame).filter((key) => !metadata.has(key))),
        ),
      ];

      // Sum the stretches of the timeline where no animated value changes.
      let flatShare = 0;
      for (let index = 1; index < frames.length; index += 1) {
        const previous = frames[index - 1];
        const current = frames[index];
        if (!previous || !current) continue;
        const unchanged = properties.every(
          (property) =>
            String(previous[property as keyof typeof previous]) ===
            String(current[property as keyof typeof current]),
        );
        if (unchanged) flatShare += (current.computedOffset ?? 0) - (previous.computedOffset ?? 0);
      }

      const element = effect.target;
      const classes = typeof element?.className === "string" ? element.className : "";
      return [
        {
          flatShare,
          name: animation instanceof CSSAnimation ? animation.animationName : "(scripted)",
          properties,
          target: `<${element?.tagName.toLowerCase() ?? "?"} class="${classes}">${effect.pseudoElement ?? ""}`,
        },
      ];
    });
  });
}

interface BlurOffender {
  readonly backgroundColor: string;
  readonly target: string;
}

/**
 * `backdrop-filter` behind a near-opaque background is invisible and still
 * costs a full re-blur of the region whenever the page produces a frame.
 */
async function collectInvisibleBlurLayers(page: Page): Promise<BlurOffender[]> {
  return await page.evaluate(() => {
    const offenders: BlurOffender[] = [];

    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      const backdrop =
        style.getPropertyValue("backdrop-filter") ||
        style.getPropertyValue("-webkit-backdrop-filter");
      if (!backdrop || backdrop === "none") continue;

      // Chromium serializes theme colours as `oklab(l a b / alpha)` and plain
      // ones as `rgba(r, g, b, alpha)`; both forms have to resolve.
      const background = style.backgroundColor;
      const slashAlpha = /\/\s*([\d.]+)(%?)\s*\)$/.exec(background);
      const commaAlpha = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/.exec(
        background,
      );
      const alpha = slashAlpha
        ? Number.parseFloat(slashAlpha[1] ?? "1") / (slashAlpha[2] === "%" ? 100 : 1)
        : commaAlpha
          ? Number.parseFloat(commaAlpha[1] ?? "1")
          : 1;
      if (alpha < 0.9) continue;

      const classes = typeof element.className === "string" ? element.className : "";
      offenders.push({
        backgroundColor: style.backgroundColor,
        target: `${element.tagName.toLowerCase()}.${classes.split(" ")[0] ?? ""}`,
      });
    }

    return offenders;
  });
}

function expectWithinBudget(animations: readonly RunawayAnimation[]) {
  const repainting = animations.filter((animation) =>
    animation.properties.some((property) => !COMPOSITED_PROPERTIES.has(property)),
  );
  expect(
    repainting,
    "Infinite animations may only animate opacity and transform; anything else repaints on the main thread every frame.",
  ).toEqual([]);

  const continuous = animations.filter(
    (animation) =>
      !TRANSIENT_ANIMATIONS.has(animation.name) && animation.flatShare < MINIMUM_FLAT_SHARE,
  );
  expect(
    continuous,
    `Infinite animations must hold a flat value across at least ${MINIMUM_FLAT_SHARE * 100}% of the cycle so unchanged frames are skipped.`,
  ).toEqual([]);
}

// The seeded instance has a running run, so its live dot shows on the Overview and on Runs.
test("keeps live run indicators inside the animation budget", async ({ page }) => {
  await mockDashboardApi(page, seededState());

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "3 things need you." })).toBeVisible();

  // The live treatment must actually be on screen, or the budget check below
  // would pass by animating nothing at all.
  await expect(page.locator(".dot.run").first()).toBeVisible();
  expectWithinBudget(await collectInfiniteAnimations(page));

  await page.goto("/runs?status=running");
  await expect(page.getByTestId("run-row").first()).toBeVisible();
  expectWithinBudget(await collectInfiniteAnimations(page));
});

test("never pays for a backdrop blur that cannot be seen", async ({ page }) => {
  await mockDashboardApi(page, seededState());

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "3 things need you." })).toBeVisible();
  expect(await collectInvisibleBlurLayers(page)).toEqual([]);

  await page.goto("/automations/verify-probe");
  await expect(page.getByRole("heading", { name: "verify-probe" })).toBeVisible();
  expect(await collectInvisibleBlurLayers(page)).toEqual([]);
});

const DASHBOARD_PAGES = [
  "/",
  "/automations/verify-probe",
  "/automations/verify-probe?tab=about",
  "/runs",
  "/credentials",
  "/settings",
] as const;

/**
 * Holds every page's API request until `open`, so a page stays in the loading state where its
 * skeletons and spinners run. The sign-in check and the environment list pass, because the shell
 * mounts no page before both answer. Register it after mockDashboardApi: the held requests then
 * fall back to the mock.
 */
async function holdDashboardData(page: Page) {
  let open = () => {};
  let held = Promise.resolve();
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/") &&
      url.pathname !== "/api/auth/status" &&
      url.pathname !== "/api/environments",
    async (route) => {
      await held;
      await route.fallback();
    },
  );
  return {
    hold() {
      held = new Promise((resolve) => {
        open = resolve;
      });
    },
    open: () => open(),
  };
}

test("stops every infinite animation on every page under prefers-reduced-motion", async ({
  page,
}) => {
  await mockDashboardApi(page, seededState());
  const data = await holdDashboardData(page);
  // Inside the page, so the shell's own "Connecting" skeleton does not count as the page's.
  const loading = page.locator("main.page .skeleton").first();

  // Without the preference the loading state animates, so the empty lists below come from the
  // preference and not from a page that animates nothing.
  data.hold();
  await page.goto("/");
  await expect(loading).toBeVisible();
  expect(await collectInfiniteAnimations(page)).not.toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await collectInfiniteAnimations(page)).toEqual([]);
  data.open();

  for (const path of DASHBOARD_PAGES) {
    data.hold();
    await page.goto(path);
    await expect(loading, `${path} shows its loading state`).toBeVisible();
    expect(await collectInfiniteAnimations(page), `${path} while loading`).toEqual([]);

    data.open();
    await expect(page.locator(".skeleton")).toHaveCount(0);
    expect(await collectInfiniteAnimations(page), `${path} once loaded`).toEqual([]);
  }

  // The live run indicator rests at a visible opacity instead of disappearing.
  await page.goto("/");
  await expect(page.locator(".dot.run").first()).toBeVisible();
});

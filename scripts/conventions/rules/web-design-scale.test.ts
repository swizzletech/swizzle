import { expect, it } from "vitest";
import { findingsFor, reported } from "../test-support.js";

const DESIGN_SCALE = JSON.stringify({
  fontSizes: [12, 13, 14, 16, 20, 24],
  radii: [6, 8, 12],
  spacing: [0, 4, 8, 12, 16, 24, 32, 48],
});

it("web-design-scale measures a token as what reads it, whatever its name", async () => {
  const css = (tokens: readonly string[], rules: readonly string[]) =>
    [":root {", ...tokens.map((one) => `  ${one}`), "}", ".a {", ...rules, "}"].join("\n");
  const scanned = (file: string, tsx = "") =>
    reported("web-design-scale", {
      "apps/web/design-scale.json": DESIGN_SCALE,
      "apps/web/src/page.css": file,
      "apps/web/src/page.tsx": tsx,
    });

  expect(
    await scanned(
      css(
        ["--page-margin: 32px;", "--page-width: 1696px;", "--blur: 7px;", "--ink: #18181b;"],
        ["  padding: 0 var(--page-margin);", "  max-width: var(--page-width);"],
      ),
      '<i className="text-[var(--ink)]" />',
    ),
  ).toEqual([]);

  for (const [token, rule] of [
    ["--page-margin: 7px;", "  padding: 0 var(--page-margin);"],
    ["--section-gap: 7px;", "  margin-top: var(--section-gap);"],
    ["--corner: 7px;", "  border-radius: var(--corner);"],
    ["--body: 15px;", "  font-size: var(--body);"],
    ["--body: 15px;", "  font: 500 var(--body) var(--font-sans);"],
  ] as const) {
    expect(await scanned(css([token], [rule]))).toEqual(["apps/web/src/page.css:2"]);
  }

  expect(
    await scanned(
      css(
        ["--inner: 7px;", "--outer: var(--inner);"],
        ["  padding: var(--outer);", "  margin: var(--outer);", "  --inner: 9px;"],
      ),
    ),
  ).toEqual(["apps/web/src/page.css:2", "apps/web/src/page.css:8"]);

  expect(await scanned(css([], ["  gap: var(--missing, 7px);"]))).toEqual([
    "apps/web/src/page.css:4",
  ]);
  expect(await scanned(css(["--a: var(--b);", "--b: var(--a);"], ["  gap: var(--a);"]))).toEqual(
    [],
  );

  for (const name of [
    "p-[var(--gutter)]",
    "gap-(--gutter)",
    "rounded-[var(--gutter)]",
    "text-[length:var(--gutter)]",
  ]) {
    expect(await scanned(css(["--gutter: 7px;"], []), `<i className="${name}" />`)).toEqual([
      "apps/web/src/page.css:2",
    ]);
  }

  expect(await scanned(css(["--spacing: 5px;"], []))).toEqual(["apps/web/src/page.css:2"]);
});

it("web-design-scale refuses a written font size, radius or spacing outside the scale", async () => {
  const onScale = {
    "apps/web/design-scale.json": DESIGN_SCALE,
    "apps/web/src/page.css": [
      ".a {",
      "  font: 500 13px / 20px var(--font-sans);",
      "  padding: 8px 16px;",
      "  margin: 0 -16px;",
      "  border-radius: 50%;",
      "  gap: var(--anything);",
      "  /* padding: 7px; a comment is not a value */",
      "}",
    ].join("\n"),
    "apps/web/src/page.tsx":
      '<div className="mt-4 -mx-2 gap-3 text-[13px] rounded-lg rounded-[50%] h-[30px] w-[50%] text-fail" />',
  };
  expect(await reported("web-design-scale", onScale)).toEqual([]);
  expect(
    await reported("web-design-scale", {
      ...onScale,
      "apps/web/src/page.css": [
        ".a {",
        "  font-size: 15px;",
        "  font: 500 11px / 20px var(--font-sans);",
        "  border-radius: 10px;",
        "  padding: 8px 14px;",
        "  gap: 1.5em;",
        "  --radius-x: 3px;",
        "}",
      ].join("\n"),
    }),
  ).toEqual([
    "apps/web/src/page.css:2",
    "apps/web/src/page.css:3",
    "apps/web/src/page.css:4",
    "apps/web/src/page.css:5",
    "apps/web/src/page.css:6",
    "apps/web/src/page.css:7",
  ]);
  expect(
    await reported("web-design-scale", {
      ...onScale,
      "apps/web/src/page.tsx": [
        '<i className="text-[12.5px]" />',
        '<i className="rounded-[10px]" />',
        '<i className="px-[18px]" />',
        '<i className="gap-1.5" />',
        '<i className="p-5" />',
        '<i className="text-lg" />',
        '<i className="rounded" />',
        '<i className="rounded-[25%]" />',
        '<i className="p-[10%]" />',
      ].join("\n"),
    }),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((line) => `apps/web/src/page.tsx:${line}`));
});

it("web-design-scale reports the CSS syntax error and continues checking other files", async () => {
  expect(
    await findingsFor("web-design-scale", {
      "apps/web/design-scale.json": DESIGN_SCALE,
      "apps/web/src/broken.css": ".valid {}\n.a { font-size: 7px",
      "apps/web/src/page.css": ".a { font-size: 7px }",
      "apps/web/src/page.tsx": '<i className="text-[length:7px]" />',
    }),
  ).toMatchObject([
    { file: "apps/web/src/broken.css", line: 2, message: "Invalid CSS: Unclosed block." },
    { file: "apps/web/src/page.css", line: 1 },
    { file: "apps/web/src/page.tsx", line: 1 },
  ]);
});

it("web-design-scale reports an inline CSS declaration without a final semicolon", async () => {
  expect(
    await reported("web-design-scale", {
      "apps/web/design-scale.json": DESIGN_SCALE,
      "apps/web/src/page.css": ".a { font-size: 7px }",
    }),
  ).toEqual(["apps/web/src/page.css:1"]);
});

it("web-design-scale locates compact declarations and tokens across nested rules", async () => {
  expect(
    await reported("web-design-scale", {
      "apps/web/design-scale.json": DESIGN_SCALE,
      "apps/web/src/page.css": [
        ":root { --gutter: 7px; --unused: 9px }",
        "@layer components {",
        "  .a { padding: var(--gutter); /* gap: 7px; */ FONT-SIZE: 15px }",
        "  .b { margin:",
        "    18px }",
        "}",
      ].join("\n"),
    }),
  ).toEqual(["apps/web/src/page.css:1", "apps/web/src/page.css:3", "apps/web/src/page.css:4"]);
});

it("web-design-scale reports a Tailwind arbitrary font size with a length hint", async () => {
  expect(
    await reported("web-design-scale", {
      "apps/web/design-scale.json": DESIGN_SCALE,
      "apps/web/src/page.tsx": [
        '<i className="text-[length:7px]" />',
        '<i className="hover:text-[size:15px]!" />',
        '<i className="text-[percentage:90%]" />',
        '<i className="text-[length:13px] text-[color:#123456]" />',
      ].join("\n"),
    }),
  ).toEqual(["apps/web/src/page.tsx:1", "apps/web/src/page.tsx:2", "apps/web/src/page.tsx:3"]);
});

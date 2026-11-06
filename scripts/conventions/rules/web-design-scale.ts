import type { Rule, Violation } from "../lint.js";
import type { Repo } from "../repo.js";

const SCALE = "apps/web/design-scale.json";
const CSS = /^apps\/web\/src\/.*\.css$/u;
const TSX = /^apps\/web\/src\/.*\.tsx$/u;

interface Scale {
  readonly fontSizes: readonly number[];
  readonly radii: readonly number[];
  readonly spacing: readonly number[];
}

type Kind = "font size" | "radius" | "spacing";

/** One `property: value` line of the dashboard's CSS. */
interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly property: string;
  readonly value: string;
}

/** What a value is measured as, whichever token it reached through. */
interface Measure {
  readonly kind: Kind;
  /** The font shorthand holds one size among its other numbers. */
  readonly shorthand: boolean;
}

/** The custom properties of the dashboard by name; a name set at two scopes has two declarations. */
type Tokens = ReadonlyMap<string, readonly Declaration[]>;

/** Tailwind's named sizes in px; each name not listed sets no size this rule reads. */
const TEXT_SIZES: Readonly<Record<string, number>> = {
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
  "5xl": 48,
  base: 16,
  lg: 18,
  sm: 14,
  xl: 20,
  xs: 12,
};
const RADII: Readonly<Record<string, number>> = {
  "": 4,
  "2xl": 16,
  "3xl": 24,
  lg: 8,
  md: 6,
  sm: 4,
  xl: 12,
  xs: 2,
};

const SPACING_UTILITY = "(?:p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy])";
const CLASS_START = "(?<![\\w-])-?";
const ARBITRARY = new RegExp(
  `${CLASS_START}(text|rounded(?:-[a-z]+)?|${SPACING_UTILITY})-\\[(-?[\\d.]+)(px|em|rem)?\\]`,
  "gu",
);
const NUMERIC = new RegExp(
  `${CLASS_START}(${SPACING_UTILITY})-(\\d+(?:\\.\\d+)?)(?![\\w.-])`,
  "gu",
);
// `text-[var(--x)]` may be a colour, so only a `length:` hint makes it a font size.
const TOKEN_CLASS = new RegExp(
  `${CLASS_START}(text(?=-[\\[(]length:)|rounded(?:-[a-z]+)?|${SPACING_UTILITY})-[\\[(](?:length:)?(?:var\\()?(--[\\w-]+)`,
  "gu",
);
const NAMED_TEXT = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-5]xl)(?![\w-])/gu;
const NAMED_RADIUS = /(?<![\w-])rounded(?:-(xs|sm|md|lg|xl|2xl|3xl))?(?![\w-])/gu;
const TOKEN_READ = /var\(\s*(--[\w-]+)/gu;

// The dashboard takes every font size, radius and spacing from one scale, so a page cannot drift
// from the others one value at a time. The Playwright spec design-foundation.spec.ts reads what a
// page draws; this rule stops a value at the line that writes it. A token counts as what reads it:
// the rule follows every `var()` of a measured property to the token's declarations, through tokens
// that read tokens, so `--page-margin: 7px` fails on its own line under `padding: var(--page-margin)`.
export const webDesignScale: Rule = {
  id: "web-design-scale",
  check(repo) {
    if (!repo.exists(SCALE)) return [];
    const scale = JSON.parse(repo.read(SCALE)) as Scale;
    const declarations = repo.files
      .filter((file) => CSS.test(file))
      .flatMap((file) => declarationsIn(repo, file));
    const tokens = tokensOf(declarations);
    const violations = [
      ...declarations.flatMap((declaration) => {
        const kind = kindOf(declaration.property);
        const shorthand = declaration.property === "font";
        return kind === undefined ? [] : measure(declaration, { kind, shorthand }, tokens, scale);
      }),
      ...repo.files
        .filter((file) => TSX.test(file))
        .flatMap((file) => checkClasses(repo, file, tokens, scale)),
    ];
    // Every reader of an off-scale token reaches the same line.
    return [...new Map(violations.map((one) => [JSON.stringify(one), one])).values()];
  },
};

function allowed(kind: Kind, scale: Scale): readonly number[] {
  if (kind === "font size") return scale.fontSizes;
  return kind === "radius" ? scale.radii : scale.spacing;
}

function outside(kind: Kind, value: string, file: string, line: number, scale: Scale): Violation {
  const values = allowed(kind, scale).join(", ");
  const full = kind === "radius" ? " or full (50%, 999px)" : "";
  return {
    file,
    line,
    message: `${value} is outside the dashboard's ${kind} scale: ${values} px${full}. The scale is in ${SCALE}.`,
  };
}

/** The property a declaration sets, as what it measures; undefined for one the scale says nothing about. */
function kindOf(property: string): Kind | undefined {
  if (property === "font-size" || property === "font" || property.startsWith("--text-")) {
    return "font size";
  }
  if (property.endsWith("radius") || property.startsWith("--radius-")) return "radius";
  return /^(padding|margin|gap|row-gap|column-gap|scroll-margin|scroll-padding|--spac(e-|ing))/u.test(
    property,
  )
    ? "spacing"
    : undefined;
}

/** Blanks comments and keeps every line break, so a line number still names the source line. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
}

function declarationsIn(repo: Repo, file: string): Declaration[] {
  return withoutComments(repo.read(file))
    .split("\n")
    .flatMap((text, index) => {
      const found = /^\s*(--[\w-]+|[a-z-]+)\s*:\s*(.+?);?\s*$/u.exec(text);
      if (found === null) return [];
      const [, property = "", value = ""] = found;
      return [{ file, line: index + 1, property, value }];
    });
}

function tokensOf(declarations: readonly Declaration[]): Tokens {
  const tokens = new Map<string, Declaration[]>();
  for (const declaration of declarations) {
    if (!declaration.property.startsWith("--")) continue;
    tokens.set(declaration.property, [...(tokens.get(declaration.property) ?? []), declaration]);
  }
  return tokens;
}

/** The lengths a value writes itself: a token's are read at its own declarations, a fallback's here. */
function lengthsIn(value: string, shorthand: boolean): readonly string[] {
  const written = value.replace(/var\(\s*--[\w-]+\s*,?/gu, "");
  // The font shorthand opens with its weight, and its size ends at a slash or a family.
  const lengths = shorthand
    ? written.match(/-?\d*\.?\d+(?:px|em|rem)/u)
    : written.match(/-?\d*\.?\d+(?:px|em|rem|%)?/gu);
  return lengths ?? [];
}

/** What a declaration sets outside the scale, itself and through every token it reads. */
function measure(
  declaration: Declaration,
  as: Measure,
  tokens: Tokens,
  scale: Scale,
  followed: ReadonlySet<string> = new Set(),
): Violation[] {
  const { file, line, value } = declaration;
  return [
    ...lengthsIn(value, as.shorthand)
      .filter((length) => !onScale(as.kind, length, scale))
      .map((length) => outside(as.kind, length, file, line, scale)),
    ...[...value.matchAll(TOKEN_READ)].flatMap(([, name = ""]) =>
      followed.has(name) ? [] : measureToken(name, as, tokens, scale, followed),
    ),
  ];
}

function measureToken(
  name: string,
  as: Measure,
  tokens: Tokens,
  scale: Scale,
  followed: ReadonlySet<string> = new Set(),
): Violation[] {
  return (tokens.get(name) ?? []).flatMap((declaration) =>
    measure(declaration, as, tokens, scale, new Set([...followed, name])),
  );
}

function onScale(kind: Kind, length: string, scale: Scale): boolean {
  if (kind === "radius" && (length === "50%" || length === "999px")) return true;
  const px = /^(-?[\d.]+)(px)?$/u.exec(length);
  if (px === null) return false;
  const value = Number(px[1]);
  // A bare number other than zero is a unitless size no scale value means.
  if (px[2] === undefined && value !== 0) return false;
  // A negative margin pulls by a step of the scale, as a Tailwind `-mt-1` does.
  return allowed(kind, scale).includes(Math.abs(value)) || (kind !== "font size" && value === 0);
}

function checkClasses(repo: Repo, file: string, tokens: Tokens, scale: Scale): Violation[] {
  const violations: Violation[] = [];
  repo
    .read(file)
    .split("\n")
    .forEach((text, index) => {
      const line = index + 1;
      const report = (kind: Kind, name: string) =>
        violations.push(outside(kind, name, file, line, scale));
      for (const [name, utility = "", value = "", unit = ""] of text.matchAll(ARBITRARY)) {
        const kind = utilityKind(utility);
        if (!onScale(kind, `${value}${unit}`, scale)) report(kind, name);
      }
      for (const [, utility = "", token = ""] of text.matchAll(TOKEN_CLASS)) {
        const as = { kind: utilityKind(utility), shorthand: false };
        violations.push(...measureToken(token, as, tokens, scale));
      }
      for (const [name, , steps = ""] of text.matchAll(NUMERIC)) {
        if (!scale.spacing.includes(Number(steps) * 4)) report("spacing", name);
      }
      for (const [name, size = ""] of text.matchAll(NAMED_TEXT)) {
        if (!scale.fontSizes.includes(TEXT_SIZES[size] ?? 0)) report("font size", name);
      }
      for (const [name, size = ""] of text.matchAll(NAMED_RADIUS)) {
        if (!scale.radii.includes(RADII[size] ?? 0)) report("radius", name);
      }
    });
  return violations;
}

function utilityKind(utility: string): Kind {
  if (utility === "text") return "font size";
  return utility.startsWith("rounded") ? "radius" : "spacing";
}

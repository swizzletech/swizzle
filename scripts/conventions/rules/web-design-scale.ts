import { CssSyntaxError, parse, type Root } from "postcss";
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

interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly property: string;
  readonly value: string;
}

interface Measure {
  readonly kind: Kind;
  readonly shorthand: boolean;
}

type Tokens = ReadonlyMap<string, readonly Declaration[]>;

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
const SIZE_HINT = "(?:length|size|percentage|absolute-size|relative-size):";
const ARBITRARY = new RegExp(
  `${CLASS_START}(text|rounded(?:-[a-z]+)?|${SPACING_UTILITY})-\\[(?:${SIZE_HINT})?(-?[\\d.]+)(px|em|rem|%)?\\]`,
  "gu",
);
const NUMERIC = new RegExp(
  `${CLASS_START}(${SPACING_UTILITY})-(\\d+(?:\\.\\d+)?)(?![\\w.-])`,
  "gu",
);
const TOKEN_CLASS = new RegExp(
  `${CLASS_START}(text(?=-[\\[(]${SIZE_HINT})|rounded(?:-[a-z]+)?|${SPACING_UTILITY})-[\\[(](?:${SIZE_HINT})?(?:var\\()?(--[\\w-]+)`,
  "gu",
);
const NAMED_TEXT = /(?<![\w-])text-(xs|sm|base|lg|xl|[2-5]xl)(?![\w-])/gu;
const NAMED_RADIUS = /(?<![\w-])rounded(?:-(xs|sm|md|lg|xl|2xl|3xl))?(?![\w-])/gu;
const TOKEN_READ = /var\(\s*(--[\w-]+)/gu;

export const webDesignScale: Rule = {
  id: "web-design-scale",
  check(repo) {
    if (!repo.exists(SCALE)) return [];
    const scale = JSON.parse(repo.read(SCALE)) as Scale;
    const { declarations, syntaxViolations } = readStylesheets(repo);
    const tokens = tokensOf(declarations);
    const violations = [
      ...syntaxViolations,
      ...declarations.flatMap((declaration) => {
        const kind = kindOf(declaration.property);
        const shorthand = declaration.property === "font";
        return kind === undefined ? [] : measure(declaration, { kind, shorthand }, tokens, scale);
      }),
      ...repo.files
        .filter((file) => TSX.test(file))
        .flatMap((file) => checkClasses(repo, file, tokens, scale)),
    ];
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

function readStylesheets(repo: Repo): {
  declarations: Declaration[];
  syntaxViolations: Violation[];
} {
  const declarations: Declaration[] = [];
  const syntaxViolations: Violation[] = [];
  for (const file of repo.files.filter((file) => CSS.test(file))) {
    let stylesheet: Root;
    try {
      stylesheet = parse(repo.read(file), { from: file, map: false });
    } catch (error) {
      if (!(error instanceof CssSyntaxError) || error.line === undefined) throw error;
      syntaxViolations.push({ file, line: error.line, message: `Invalid CSS: ${error.reason}.` });
      continue;
    }
    stylesheet.walkDecls(({ prop, value, source }) => {
      const start = source?.start;
      if (start === undefined) throw new Error(`Missing CSS declaration position in ${file}.`);
      declarations.push({
        file,
        line: start.line,
        property: prop.startsWith("--") ? prop : prop.toLowerCase(),
        value,
      });
    });
  }
  return { declarations, syntaxViolations };
}

function tokensOf(declarations: readonly Declaration[]): Tokens {
  const tokens = new Map<string, Declaration[]>();
  for (const declaration of declarations) {
    if (!declaration.property.startsWith("--")) continue;
    tokens.set(declaration.property, [...(tokens.get(declaration.property) ?? []), declaration]);
  }
  return tokens;
}

function lengthsIn(value: string, shorthand: boolean): readonly string[] {
  const written = value.replace(/var\(\s*--[\w-]+\s*,?/gu, "");
  const lengths = shorthand
    ? written.match(/-?\d*\.?\d+(?:px|em|rem)/u)
    : written.match(/-?\d*\.?\d+(?:px|em|rem|%)?/gu);
  return lengths ?? [];
}

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
  if (px[2] === undefined && value !== 0) return false;
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

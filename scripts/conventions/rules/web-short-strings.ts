import ts from "typescript";
import type { Rule } from "../lint.js";

const ATTRIBUTES = new Set(["aria-label", "description", "empty", "label", "placeholder", "title"]);
const TITLE_TAGS = new Set([
  "b",
  "button",
  "h1",
  "h2",
  "h3",
  "h4",
  "label",
  "legend",
  "option",
  "strong",
  "summary",
  "th",
]);
const CAPTION_TAGS = new Set(["dd", "div", "li", "p", "pre", "span"]);
const CAPTION_WORDS = 8;
const WORDS_MODULE = /^apps\/web\/src\/lib\/words\/[^/]+\.ts$/u;
const DASHBOARD_PAGE = /^apps\/web\/src\/.*\.tsx$/u;

interface ShortStringPeriod {
  readonly position: number;
  readonly line: number;
  readonly text: string;
}

function endsShort(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.endsWith(".") &&
    !trimmed.endsWith("..") &&
    !text.startsWith(" ") &&
    !/[.?!;]\s+\S/u.test(trimmed)
  );
}

function literalsOf(
  node: ts.Expression,
): readonly (ts.StringLiteralLike | ts.TemplateExpression)[] {
  if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) return [node];
  if (ts.isParenthesizedExpression(node)) return literalsOf(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...literalsOf(node.whenTrue), ...literalsOf(node.whenFalse)];
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...literalsOf(node.left), ...literalsOf(node.right)];
  }
  return [];
}

function textOf(node: ts.StringLiteralLike | ts.TemplateExpression): string {
  if (!ts.isTemplateExpression(node)) return node.text;
  return [node.head.text, ...node.templateSpans.map((span) => `x${span.literal.text}`)].join("");
}

function literalPeriod(node: ts.StringLiteralLike | ts.TemplateExpression): number {
  return node.getEnd() - 2;
}

function tagOf(node: ts.JsxElement): string {
  return node.openingElement.tagName.getText();
}

function runsOn(element: ts.JsxElement): boolean {
  const parent = element.parent;
  if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) return false;
  return parent.children.some((sibling) => {
    if (sibling === element) return false;
    if (ts.isJsxText(sibling)) return sibling.text.trim() !== "";
    if (!ts.isJsxExpression(sibling) || sibling.expression === undefined) return false;
    const { expression } = sibling;
    return (
      ts.isIdentifier(expression) ||
      ts.isPropertyAccessExpression(expression) ||
      ts.isStringLiteralLike(expression) ||
      ts.isTemplateExpression(expression)
    );
  });
}

function elementPeriod(element: ts.JsxElement): readonly [string, number][] {
  const tag = tagOf(element);
  const title = TITLE_TAGS.has(tag);
  if ((!title && !CAPTION_TAGS.has(tag)) || runsOn(element)) return [];
  const children = element.children.filter(
    (child) => !ts.isJsxText(child) || child.text.trim() !== "",
  );
  if (children.some((child) => !ts.isJsxText(child) && !ts.isJsxExpression(child))) return [];
  const last = children.at(-1);
  if (last === undefined) return [];
  const before = children
    .slice(0, -1)
    .map((child) => (ts.isJsxText(child) ? child.text : "x"))
    .join("");
  const sites: [string, number][] = [];
  if (ts.isJsxText(last)) {
    const end = last.getStart() + last.getText().trimEnd().length - 1;
    sites.push([`${before}${last.text}`.replace(/\s+/gu, " ").trim(), end]);
  } else if (ts.isJsxExpression(last) && last.expression !== undefined) {
    for (const literal of literalsOf(last.expression)) {
      sites.push([`${before}${textOf(literal)}`, literalPeriod(literal)]);
    }
  }
  return sites.filter(
    ([text]) => title || text.split(/\s+/u).filter(Boolean).length <= CAPTION_WORDS,
  );
}

function shortStringPeriods(file: string, content: string): readonly ShortStringPeriod[] {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const periods: ShortStringPeriod[] = [];
  const report = (text: string, position: number): void => {
    if (!endsShort(text)) return;
    const { line } = source.getLineAndCharacterOfPosition(position);
    periods.push({ line: line + 1, position, text: text.trim() });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText())) {
      const value = node.initializer;
      const expression =
        value !== undefined && ts.isJsxExpression(value) ? value.expression : value;
      if (expression !== undefined) {
        for (const literal of literalsOf(expression)) {
          report(textOf(literal), literalPeriod(literal));
        }
      }
    }
    if (ts.isJsxElement(node)) {
      for (const [text, position] of elementPeriod(node)) report(text, position);
    }
    if (
      WORDS_MODULE.test(file) &&
      ts.isPropertyAssignment(node) &&
      node.name.getText() === "title"
    ) {
      for (const literal of literalsOf(node.initializer)) {
        report(textOf(literal), literalPeriod(literal));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return periods;
}

export const webShortStrings: Rule = {
  id: "web-short-strings",
  check(repo) {
    return repo.files
      .filter(
        (file) =>
          (DASHBOARD_PAGE.test(file) || WORDS_MODULE.test(file)) && !file.includes(".test."),
      )
      .flatMap((file) =>
        shortStringPeriods(file, repo.read(file)).map(({ line, text }) => ({
          file,
          line,
          message: `"${text}" is a short string, so it ends without a period. Only a sentence in running text keeps one.`,
        })),
      );
  },
};

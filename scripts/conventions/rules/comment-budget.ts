import ts from "typescript";
import type { Rule, Violation } from "../lint.js";

const BUDGET = "scripts/conventions/comment-budget.json";
const SOURCE = /^(?:apps|packages|scripts|test|\.agents\/checks)\/.*\.(?:[cm]?ts|tsx|css|html)$/u;
const GENERATED_FILES: Readonly<Record<string, string>> = {};
const PUBLIC_API: Readonly<Record<string, string>> = {
  "packages/sdk-ts/src/index.ts": "The TypeScript SDK copied into automations",
  "apps/cli/assets/sdk/swizzle-sdk.ts": "The SDK source shipped in the CLI package for scaffolding",
};
const LICENSE =
  /^(?:Copyright\s+(?:\(c\)\s+|©\s*)?\d{4}|SPDX-License-Identifier:\s*\S|@license\b|Licensed under\b)/iu;
const BIOME_IGNORE = /^biome-ignore(?:-all|-start|-end)?\s+[^:\s]+(?:\s+[^:\s]+)*:\s*\S/u;
const TS_CHECK_DIRECTIVE = /^\/?\s*@ts-(?:check|nocheck)$/iu;
const TS_ERROR_DIRECTIVE = /^@ts-(?:ignore|expect-error)(?:\s|:|$)/u;
const VITEST_DIRECTIVE = /^@vitest-environment[ \t]+[\w-]+$/u;
const REFERENCE =
  /^\/\s*<reference\s[^>]*\b(?:path|types|lib|no-default-lib)\s*=\s*(?:"[^"]*"|'[^']*')[^>]*\/>/iu;
const HAZARD = /^HAZARD:\s*\S/u;
const CSS_TOKENS =
  /\\[^\r\n\f]|"(?:\\[\s\S]|[^"\\\r\n\f])*"|'(?:\\[\s\S]|[^'\\\r\n\f])*'|(?<![\w-])url\((?!\s*["'])(?:\\[\s\S]|[^\\)])*(?:\)|$)|\/\*(?<comment>[\s\S]*?)(?:\*\/|$)/giu;
const HTML_TAG_END = `(?:[^"'<>]|"[^"]*"|'[^']*')*>`;
const HTML_TOKENS = new RegExp(
  String.raw`<!--(?<comment>[\s\S]*?)(?:--!?>|$)|<(?<rawTag>script|style|textarea|title|iframe|xmp|noembed|noframes)(?=[\s/>])${HTML_TAG_END}(?<rawBody>[\s\S]*?)(?:<\/\k<rawTag>\s*>|$)|<\/?[a-z]${HTML_TAG_END}`,
  "dgiu",
);
const NEWLINE = /\r\n?|\n/u;
const EXPLAIN =
  "Carry the meaning in a name, a type, a test, or the commit message. Put a hazard behind `HAZARD:` on the line it guards.";

export const commentBudget: Rule = {
  id: "comment-budget",
  allowInlineException: false,
  check(repo, notice) {
    const invalidBudget = (message: string): Violation[] => [{ file: BUDGET, line: 1, message }];
    if (!repo.exists(BUDGET)) return invalidBudget("Restore the committed comment budget.");
    const budget = readBudget(repo.read(BUDGET));
    if (budget === undefined) return invalidBudget("Use source paths and positive integer counts.");
    const baseText = repo.readBaseline?.(BUDGET);
    const violations: Violation[] = [];
    if (baseText === undefined) {
      if (repo.readBaseline !== undefined && process.env.CI === "true") {
        return invalidBudget(
          "CI requires a committed comment budget baseline. Fetch the history of main.",
        );
      }
      notice("comment-budget: growth check skipped. No committed baseline is available.");
    } else {
      const baseline = readBudget(baseText);
      if (baseline === undefined) return invalidBudget("The committed baseline budget is invalid.");
      for (const [file, count] of budget) {
        const previous = baseline.get(file) ?? 0;
        if (count > previous) {
          violations.push(
            ...invalidBudget(
              `${file} raises its comment budget from ${previous} to ${count}. ${EXPLAIN}`,
            ),
          );
        }
      }
    }
    for (const file of repo.files) {
      if (!SOURCE.test(file) || Object.hasOwn(GENERATED_FILES, file)) continue;
      const expected = budget.get(file) ?? 0;
      budget.delete(file);
      const comments = countedComments(file, repo.read(file));
      const excess = comments[expected];
      if (excess !== undefined) {
        violations.push({
          file,
          line: excess,
          message: `The comment count of ${comments.length} exceeds the budget of ${expected}. ${EXPLAIN}`,
        });
      }
      if (comments.length < expected) {
        violations.push(...invalidBudget(lowerBudget(file, comments.length, expected)));
      }
    }
    for (const [file, expected] of budget)
      violations.push(...invalidBudget(lowerBudget(file, 0, expected)));
    return violations;
  },
};

function lowerBudget(file: string, count: number, expected: number): string {
  const fix = count === 0 ? "Remove its budget entry." : `Lower its budget entry to ${count}.`;
  return `${file} has ${count} comments, with a budget of ${expected}. ${fix}`;
}

function readBudget(text: string): Map<string, number> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const budget = new Map<string, number>();
  for (const [file, count] of Object.entries(parsed)) {
    if (
      !SOURCE.test(file) ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 1
    )
      return undefined;
    budget.set(file, count);
  }
  return budget;
}

function countedComments(file: string, text: string): number[] {
  if (file.endsWith(".css")) return cssComments(text);
  if (file.endsWith(".html")) return htmlComments(file, text);
  return typescriptComments(file, text);
}

function cssComments(text: string): number[] {
  return delimitedComments(text, [...text.matchAll(CSS_TOKENS)]);
}

function htmlComments(file: string, text: string): number[] {
  const tokens = [...text.matchAll(HTML_TOKENS)];
  const lines = delimitedComments(text, tokens);
  for (const token of tokens) {
    const tag = token.groups?.rawTag?.toLowerCase();
    if (tag !== "style" && tag !== "script") continue;
    const body = token.groups?.rawBody;
    const start = token.indices?.groups?.rawBody?.[0];
    if (body === undefined || start === undefined) continue;
    const embedded = tag === "style" ? cssComments(body) : typescriptComments(`${file}.js`, body);
    const precedingLines = text.slice(0, start).split(NEWLINE).length - 1;
    for (const line of embedded) lines.push(precedingLines + line);
  }
  return lines.sort((a, b) => a - b);
}

function typescriptComments(file: string, text: string): number[] {
  if (!text.includes("//") && !text.includes("/*")) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const literals: ts.TextRange[] = [];
  const jsxComments: ts.TextRange[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      literals.push(node);
      return;
    }
    if (
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateMiddleOrTemplateTail(node) ||
      (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent))
    ) {
      literals.push({ pos: node.getStart(source), end: node.end });
      return;
    }
    if (ts.isJsxExpression(node) && node.expression === undefined)
      jsxComments.push({ pos: node.getStart(source) + 1, end: node.end - 1 });
    ts.forEachChild(node, visit);
  };
  visit(source);
  const apiDocs = Object.hasOwn(PUBLIC_API, file) ? exportedJsDoc(source) : new Set<number>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, text);
  const comments: number[] = [];
  let literalIndex = 0;
  let jsxIndex = 0;
  let lastTokenEnd = 0;
  while (true) {
    const literal = literals[literalIndex];
    if (literal !== undefined && scanner.getTextPos() >= literal.pos) {
      literalIndex += 1;
      if (scanner.getTextPos() < literal.end) scanner.setTextPos(literal.end);
      lastTokenEnd = literal.end;
      continue;
    }
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (
      kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
      kind !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      if (kind > ts.SyntaxKind.LastTriviaToken) lastTokenEnd = scanner.getTextPos();
      continue;
    }
    const pos = scanner.getTokenStart();
    const end = scanner.getTextPos();
    const body = text
      .slice(pos + 2, kind === ts.SyntaxKind.MultiLineCommentTrivia ? end - 2 : end)
      .trim()
      .replace(/^\*\s*/u, "");
    if (BIOME_IGNORE.test(body)) continue;
    while ((jsxComments[jsxIndex]?.end ?? Infinity) <= pos) jsxIndex += 1;
    if ((jsxComments[jsxIndex]?.pos ?? Infinity) > pos) {
      if (apiDocs.has(pos) || TS_ERROR_DIRECTIVE.test(body)) continue;
      if (
        lastTokenEnd === 0 &&
        (LICENSE.test(body) ||
          (file.endsWith(".test.ts") && isVitestDocblock(body)) ||
          (kind === ts.SyntaxKind.SingleLineCommentTrivia &&
            (REFERENCE.test(body) || TS_CHECK_DIRECTIVE.test(body))))
      )
        continue;
      if (HAZARD.test(body) && guardsCodeLine(source, { pos, end }, lastTokenEnd)) continue;
    }
    comments.push(lineOf(source, pos) + 1);
  }
  return comments;
}

function isVitestDocblock(body: string): boolean {
  return body
    .split(NEWLINE)
    .every((line) => VITEST_DIRECTIVE.test(line.trim().replace(/^\*\s*/u, "")));
}

function delimitedComments(text: string, tokens: readonly RegExpExecArray[]): number[] {
  const comments = tokens.flatMap((match) => {
    const body = match.groups?.comment;
    return body === undefined
      ? []
      : [{ pos: match.index, end: match.index + match[0].length, body: body.trim() }];
  });
  return comments.flatMap(({ pos, end, body }, index) => {
    if (BIOME_IGNORE.test(body) || (LICENSE.test(body) && !text.slice(0, pos).trim())) return [];
    if (HAZARD.test(body)) {
      const before = text
        .slice(comments[index - 1]?.end ?? 0, pos)
        .split(NEWLINE)
        .at(-1);
      const [sameLine, nextLine] = text.slice(end, comments[index + 1]?.pos).split(NEWLINE, 2);
      if (before?.trim() || sameLine?.trim() || nextLine?.trim()) return [];
    }
    return [text.slice(0, pos).split(NEWLINE).length];
  });
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line;
}

function guardsCodeLine(
  source: ts.SourceFile,
  comment: ts.TextRange,
  lastTokenEnd: number,
): boolean {
  if (lastTokenEnd > 0 && lineOf(source, lastTokenEnd) === lineOf(source, comment.pos)) return true;
  const lines = source.getLineStarts();
  const endLine = lineOf(source, comment.end);
  const next = lines[endLine + 1];
  const code = (text: string): boolean => text !== "" && !/^(?:\/\/|\/\*)/u.test(text);
  return (
    code(source.text.slice(comment.end, next).trim()) ||
    (next !== undefined && code(source.text.slice(next, lines[endLine + 2]).trim()))
  );
}

function exportedJsDoc(source: ts.SourceFile): Set<number> {
  const docs = new Set<number>();
  const names = new Set<string>();
  const collect = (node: ts.Node): void => {
    for (const doc of ts.getJSDocCommentsAndTags(node)) {
      if (ts.isJSDoc(doc) && doc.parent === node) docs.add(doc.getStart(source));
    }
  };
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements)
          names.add((element.propertyName ?? element.name).text);
      }
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression))
      names.add(statement.expression.text);
  }
  for (const statement of source.statements) {
    if (!ts.canHaveModifiers(statement)) continue;
    const exported = ts
      .getModifiers(statement)
      ?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword);
    const name = ts.isDeclarationStatement(statement) ? statement.name : undefined;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (exported || (ts.isIdentifier(declaration.name) && names.has(declaration.name.text))) {
          collect(statement);
          collect(declaration);
        }
      }
    }
    if (!exported && !(name && ts.isIdentifier(name) && names.has(name.text))) continue;
    collect(statement);
    if (
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      for (const member of statement.members) {
        if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) continue;
        if (
          ts.canHaveModifiers(member) &&
          ts.getModifiers(member)?.some(({ kind }) => kind === ts.SyntaxKind.PrivateKeyword)
        )
          continue;
        collect(member);
      }
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      const collectTypeMembers = (node: ts.Node): void => {
        if (ts.isTypeElement(node)) collect(node);
        ts.forEachChild(node, collectTypeMembers);
      };
      collectTypeMembers(statement.type);
    }
  }
  return docs;
}

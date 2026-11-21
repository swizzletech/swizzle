import ts from "typescript";
import type { Rule, Violation } from "../lint.js";

const TEST_CODE =
  /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test\/[^/]+\.[cm]?[jt]sx?$|^apps\/web\/tests\/[^/]+\.[cm]?[jt]sx?$/u;
const RUNNER_CONFIG = /^(vitest|playwright)\.config\.[cm]?[jt]s$/u;

const SLEEP =
  "A test waits on a state or an event, never on time. Await the promise or event that marks the step, a web-first assertion such as `await expect(locator).toBeVisible()`, or `waitFor(signal, predicate)` from test/support.ts; drive time the code reads with `vi.useFakeTimers()` or `page.clock`.";
const BUDGET =
  "The timeout in vitest.config.ts or playwright.config.ts is the only ceiling, and a flaky test is fixed, not retried. Remove the override and await the state the test needs.";
const ELAPSED =
  "Elapsed wall-clock time depends on the runner's load. Assert on the event or count that shows the behaviour, or fix the clock with `vi.setSystemTime()` or `page.clock` and assert the exact value.";
const OWN_POLL =
  "vi.waitFor, vi.waitUntil and Vitest's expect.poll give up after their own one-second budget, so a slow runner fails them. Await the event, or poll with `waitFor(signal, predicate)` from test/support.ts, which only the test timeout bounds.";
const TICK_LOOP =
  "A loop that spins on ticks waits on the scheduler, not on the code under test. Await the promise or event that marks the step, or poll with `waitFor(signal, predicate)` from test/support.ts.";
const DEADLINE =
  "A real deadline in a test fails when a loaded runner is slower than it. Pass the test's `signal` to bound a wait, or let the test trip the code's deadline with `heldDeadlines(ms)` from test/support.ts once the stall it proves is in place.";
const RETRY_CONFIG =
  "A flaky test is fixed, not retried: a retry hides the race that fails it. Remove the retry setting.";

const TIMER_MODULES = new Set(["node:timers/promises", "timers/promises", "node:timers", "timers"]);
const SLEEPS = new Set(["setTimeout", "setInterval"]);
const TICKS = new Set(["setImmediate", "nextTick"]);
const GLOBALS = new Set(["globalThis", "window", "self"]);
const REGISTRARS = new Set(["it", "test", "describe", "suite", "bench"]);
const HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const BUDGET_KEYS = new Set([
  "timeout",
  "retry",
  "retries",
  "testTimeout",
  "hookTimeout",
  "actionTimeout",
  "navigationTimeout",
]);
const BUDGET_SETTERS = new Set(["setTimeout", "setDefaultTimeout", "setDefaultNavigationTimeout"]);
const UPPER_BOUNDS = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
const DURATION = /elapsed|duration|latency/iu;
const CLOCK_FAKES = new Set(["Date", "performance", "hrtime"]);
const CLOCKS = new Set(["Date.now", "performance.now", "process.hrtime", "process.hrtime.bigint"]);
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);
const MEASURES = new Set([
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

export const testsWaitOnState: Rule = {
  id: "tests-wait-on-state",
  check(repo) {
    return repo.files.flatMap((file) => {
      if (RUNNER_CONFIG.test(file)) return retrySettings(file, repo.read(file));
      return TEST_CODE.test(file) ? timeWaits(file, repo.read(file)) : [];
    });
  },
};

function timeWaits(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const report = (node: ts.Node, message: string) =>
    violations.push({ file, line: lineOf(source, node), message });
  const imported = new Map<string, string>();
  const modules = new Set<string>();
  const playwright = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@playwright/test",
  );
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!TIMER_MODULES.has(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined) modules.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements)
      imported.set(element.name.text, (element.propertyName ?? element.name).text);
  }
  const timerName = (callee: ts.Expression): string | undefined => {
    if (ts.isIdentifier(callee)) return imported.get(callee.text) ?? callee.text;
    const [root, ...members] = memberPath(callee) ?? [];
    if (root !== undefined && modules.has(root)) return members.at(-1);
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      if (GLOBALS.has(callee.expression.text)) return callee.name.text;
      if (callee.expression.text === "process" && callee.name.text === "nextTick")
        return "nextTick";
    }
    return undefined;
  };

  const clockNames = new Set<string>();
  let setsClock = false;
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && setsTheClock(node)) setsClock = true;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      if (readsClock(node.initializer)) clockNames.add(node.name.text);
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      ASSIGNMENTS.has(node.operatorToken.kind) &&
      readsClock(node.right)
    )
      clockNames.add(node.left.text);
    ts.forEachChild(node, collect);
  };
  const readsClock = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && clockNames.has(node.text)) ||
    (ts.isCallExpression(node) && CLOCKS.has(memberPath(node.expression)?.join(".") ?? "")) ||
    (ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments?.length ?? 0) === 0) ||
    (!ts.isFunctionLike(node) && (ts.forEachChild(node, readsClock) ?? false));
  collect(source);

  const visit = (node: ts.Node, inLoop: boolean): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = timerName(callee);
      const path = memberPath(callee);
      if (name !== undefined && SLEEPS.has(name)) report(node, SLEEP);
      else if (name !== undefined && TICKS.has(name) && inLoop) report(node, TICK_LOOP);
      else if (path?.at(-1) === "waitForTimeout") report(node, SLEEP);
      else if (path?.length === 2 && path[0] === "vi" && /^wait(For|Until)$/u.test(path[1] ?? ""))
        report(node, OWN_POLL);
      else if (!playwright && path?.join(".") === "expect.poll") report(node, OWN_POLL);
      else if (path?.join(".") === "process.hrtime" && node.arguments.length > 0) {
        if (!setsClock) report(node, ELAPSED);
      } else if (isDurationBound(node)) {
        if (!setsClock) report(node, ELAPSED);
      } else if (path !== undefined) {
        const budget = budgetOf(node, path);
        if (budget !== undefined) report(budget, BUDGET);
      }
      for (const argument of node.arguments)
        budgetsIn(argument, (property) => report(property, BUDGET));
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      memberPath(node)?.join(".") === "AbortSignal.timeout"
    )
      report(node, DEADLINE);
    if (
      !setsClock &&
      ts.isBinaryExpression(node) &&
      MEASURES.has(node.operatorToken.kind) &&
      readsClock(node.left) &&
      readsClock(node.right)
    )
      report(node, ELAPSED);
    const loopBody = isLoop(node) ? true : ts.isFunctionLike(node) ? false : inLoop;
    ts.forEachChild(node, (child) => visit(child, loopBody));
  };
  visit(source, false);
  return violations;
}

function budgetOf(node: ts.CallExpression, path: readonly string[]): ts.Node | undefined {
  const [root = "", ...members] = path;
  if (BUDGET_SETTERS.has(members.at(-1) ?? "")) return node;
  if (REGISTRARS.has(root) && members.at(-1) === "slow") return node;
  if (!REGISTRARS.has(root) && !HOOKS.has(root)) return undefined;
  const hook = HOOKS.has(root) && members.length === 0;
  const argument = node.arguments[hook ? 1 : 2];
  if (argument === undefined || ts.isFunctionLike(argument)) return undefined;
  if (ts.isObjectLiteralExpression(argument)) return undefined;
  const before = node.arguments[1];
  return !hook && before !== undefined && ts.isObjectLiteralExpression(before)
    ? undefined
    : argument;
}

function setsTheClock(node: ts.CallExpression): boolean {
  const path = memberPath(node.expression)?.join(".") ?? "";
  if (path === "vi.setSystemTime" || /\.clock\.(install|setFixedTime|setSystemTime)$/u.test(path))
    return true;
  if (path !== "vi.useFakeTimers") return false;
  const options = node.arguments[0];
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return true;
  const toFake = options.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property) === "toFake",
  );
  if (toFake === undefined || !ts.isPropertyAssignment(toFake)) return true;
  const faked = toFake.initializer;
  return (
    !ts.isArrayLiteralExpression(faked) ||
    faked.elements.some((element) => ts.isStringLiteral(element) && CLOCK_FAKES.has(element.text))
  );
}

function budgetsIn(node: ts.Expression, found: (property: ts.Node) => void): void {
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (BUDGET_KEYS.has(property.name.text)) found(property);
    } else if (ts.isPropertyAssignment(property)) {
      const value = property.initializer;
      if (!BUDGET_KEYS.has(propertyName(property) ?? "")) budgetsIn(value, found);
      else if (isConstantNumber(value) || ts.isIdentifier(value)) found(property);
    }
  }
}

function isDurationBound(node: ts.CallExpression): boolean {
  const matcher = node.expression;
  if (!ts.isPropertyAccessExpression(matcher) || !UPPER_BOUNDS.has(matcher.name.text)) return false;
  const subject = expectedSubject(matcher.expression);
  if (subject === undefined) return false;
  const name = ts.isPropertyAccessExpression(subject)
    ? subject.name.text
    : ts.isIdentifier(subject)
      ? subject.text
      : "";
  return DURATION.test(name);
}

function expectedSubject(node: ts.Expression): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node)) return expectedSubject(node.expression);
  if (!ts.isCallExpression(node)) return undefined;
  const path = memberPath(node.expression)?.join(".");
  return path === "expect" || path === "expect.soft" ? node.arguments[0] : undefined;
}

function retrySettings(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralElementLike(node) && /^retr(y|ies)$/u.test(propertyName(node) ?? ""))
      violations.push({ file, line: lineOf(source, node), message: RETRY_CONFIG });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

function memberPath(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const head = memberPath(node.expression);
    return head === undefined ? undefined : [...head, node.name.text];
  }
  if (ts.isCallExpression(node)) return memberPath(node.expression);
  return undefined;
}

function isConstantNumber(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isConstantNumber(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return isConstantNumber(node.operand);
  if (ts.isBinaryExpression(node))
    return isConstantNumber(node.left) && isConstantNumber(node.right);
  return false;
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node)
  );
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  const name = node.name;
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : undefined;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

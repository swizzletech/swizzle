import ts from "typescript";
import type { Rule, Violation } from "../lint.js";

// A test waits on a state or an event, never on time: no sleep, no polling loop of its own, no
// elapsed-time or duration assertion, no timeout, deadline or retry of its own. Each of these passes
// on an idle machine and fails on a loaded runner. The runner configurations hold the only
// ceilings, and a flaky test is fixed at its race, not retried. The check reads each file's syntax
// tree, so code in a string, such as an automation a test writes to disk, is not the test's wait.

/** Test files and the helpers only tests import. */
const TEST_CODE =
  /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test\/[^/]+\.[cm]?[jt]sx?$|^apps\/web\/tests\/[^/]+\.[cm]?[jt]sx?$/u;
/** The runner configurations, where a retry would rerun every failing test. */
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
/** Calls that set a ceiling for the rest of the test: `test.setTimeout(ms)`, `page.setDefaultTimeout(ms)`. */
const BUDGET_SETTERS = new Set(["setTimeout", "setDefaultTimeout", "setDefaultNavigationTimeout"]);
/** Matchers that put an upper bound on their subject. */
const UPPER_BOUNDS = new Set(["toBeLessThan", "toBeLessThanOrEqual"]);
/** A subject named for how long something took, such as `result.durationMs`. */
const DURATION = /elapsed|duration|latency/iu;
/** What `vi.useFakeTimers({ toFake })` names when it fakes the clock a test reads. */
const CLOCK_FAKES = new Set(["Date", "performance", "hrtime"]);
const CLOCKS = new Set(["Date.now", "performance.now", "process.hrtime", "process.hrtime.bigint"]);
const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
]);
/** A difference or a comparison of two clock readings measures how long something took. */
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
  // Local names of the timer functions imported from Node's timer modules, by their exported name,
  // and the names a whole timer module is imported under, such as `import * as timers`.
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

  // Names that hold a clock reading, such as `const started = performance.now()`: two readings
  // measure a duration, while one reading with a fixed offset only dates a fixture. In a file that
  // sets the clock, a duration is the exact value the test set, so it measures no load.
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
    // A callback in a loop runs on its own schedule, not the loop's.
    const loopBody = isLoop(node) ? true : ts.isFunctionLike(node) ? false : inLoop;
    ts.forEachChild(node, (child) => visit(child, loopBody));
  };
  visit(source, false);
  return violations;
}

/**
 * `test.setTimeout(ms)` or `testInfo.setTimeout(ms)`, `test.slow()`, or the timeout after a test's
 * or a hook's body, such as `it(name, body, 10_000)` or `beforeAll(body, TIMEOUT)`. After an
 * options object, as in `test(name, { tag }, body)`, the third argument is the body. Options after
 * the body are object literals, which `budgetsIn` reads. A global `setTimeout` never gets here: it
 * is a sleep.
 */
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

/**
 * `vi.setSystemTime(...)`, `vi.useFakeTimers()` that fakes the clock, or Playwright's
 * `page.clock.install()`, `setFixedTime()` or `setSystemTime()`.
 */
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

/**
 * A timeout or retry an option object sets to a number, however deep, such as
 * `{ timeout: 2_000 }`, `{ timeout: SHORT }` or `test.use({ expect: { timeout } })`. A string or an
 * object under the same key, such as an automation's `timeout: "60s"`, is data the test expects.
 */
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

/** `expect(result.durationMs).toBeLessThan(...)`: an upper bound on how long something took. */
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

/** The subject of `expect(subject)`, also through `.not`, `.soft` or `.resolves`. */
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

/** `a.b.c` of a callee written as identifiers and property names, through calls such as `it.each(x)`. */
function memberPath(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const head = memberPath(node.expression);
    return head === undefined ? undefined : [...head, node.name.text];
  }
  if (ts.isCallExpression(node)) return memberPath(node.expression);
  return undefined;
}

/** A number the source spells out, such as `30_000` or `11 * 60_000`. */
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

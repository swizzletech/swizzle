import ts from "typescript";
import type { Rule, Violation } from "../lint.js";

const TEST_CODE =
  /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test\/[^/]+\.[cm]?[jt]sx?$|^apps\/web\/tests\/.+\.[cm]?[jt]sx?$/u;
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
const CLOCKS = new Map([
  ["Date.now", "Date"],
  ["performance.now", "performance"],
  ["process.hrtime", "hrtime"],
  ["process.hrtime.bigint", "hrtime"],
]);
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
const SHORT_CIRCUIT = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
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
  const playwright =
    file.startsWith("apps/web/tests/") ||
    source.statements.some(
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

  const clockValues = new Map<ts.Node, Map<string, ts.Expression>>();
  const remember = (name: ts.Identifier, value: ts.Expression) => {
    const owner = functionOf(name);
    const variables = clockValues.get(owner) ?? new Map();
    if (!variables.has(name.text)) variables.set(name.text, value);
    clockValues.set(owner, variables);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      remember(node.name, node.initializer);
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      ASSIGNMENTS.has(node.operatorToken.kind)
    )
      remember(node.left, node.right);
    ts.forEachChild(node, collect);
  };
  const clockValue = (name: ts.Identifier): ts.Expression | undefined => {
    for (let scope = functionOf(name); ; scope = functionOf(scope.parent)) {
      const value = clockValues.get(scope)?.get(name.text);
      if (value !== undefined || scope.parent === undefined) return value;
    }
  };
  const clockReads = (node: ts.Node, seen = new Set<ts.Node>()): ts.Node[] => {
    if (seen.has(node) || ts.isFunctionLike(node)) return [];
    seen.add(node);
    if (clockKind(node) !== undefined) return [node];
    const value = ts.isIdentifier(node) ? clockValue(node) : undefined;
    if (value !== undefined) return clockReads(value, seen);
    const reads: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      reads.push(...clockReads(child, seen));
    });
    return reads;
  };
  collect(source);
  const fakeReads = fakeClockReads(source);

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
        if (!fakeReads.has(node)) report(node, ELAPSED);
      } else if (isDurationBound(node)) {
        const subject = ts.isPropertyAccessExpression(callee)
          ? expectedSubject(callee.expression)
          : undefined;
        const reads = subject === undefined ? [] : clockReads(subject);
        if (reads.length === 0 || reads.some((read) => !fakeReads.has(read))) report(node, ELAPSED);
      } else if (path !== undefined) {
        const budget = budgetOf(node, path);
        if (budget !== undefined) report(budget, BUDGET);
      }
      const runner = path?.[0] ?? "";
      const runnerConfig = REGISTRARS.has(runner) || HOOKS.has(runner);
      for (const argument of node.arguments)
        budgetsIn(argument, runnerConfig, (property) => report(property, BUDGET));
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      memberPath(node)?.join(".") === "AbortSignal.timeout"
    )
      report(node, DEADLINE);
    if (ts.isBinaryExpression(node) && MEASURES.has(node.operatorToken.kind)) {
      const left = clockReads(node.left);
      const right = clockReads(node.right);
      if (
        left.length > 0 &&
        right.length > 0 &&
        [...left, ...right].some((read) => !fakeReads.has(read))
      )
        report(node, ELAPSED);
    }
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

function functionOf(node: ts.Node): ts.Node {
  for (let current = node; current.parent !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return node.getSourceFile();
}

function clockKind(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) return CLOCKS.get(memberPath(node.expression)?.join(".") ?? "");
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    (node.arguments?.length ?? 0) === 0
  )
    return "Date";
  return undefined;
}

type ClockState = ReadonlySet<string>;
type ObserveClockState = (node: ts.Node, clocks: ClockState) => void;
type ClockHook = { readonly body: ts.Node; readonly optional: boolean };

function fakeClockReads(source: ts.SourceFile): WeakSet<ts.Node> {
  const fake = new WeakSet<ts.Node>();
  const observe: ObserveClockState = (node, clocks) => {
    const clock = clockKind(node);
    if (clock !== undefined && clocks.has(clock)) fake.add(node);
  };
  const hooks = new Map<ts.Node, ClockHook[]>();
  const functions: { body: ts.Node; testScope?: ts.Node }[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      const scope = functionOf(node.parent);
      const registration = ts.isCallExpression(node.parent) ? node.parent : undefined;
      const path = registration ? (memberPath(registration.expression) ?? []) : [];
      const name = path.join(".");
      const test =
        (path[0] === "it" || path[0] === "test") &&
        !path.includes("describe") &&
        !path.includes("step");
      if (registration && (name === "beforeEach" || name === "test.beforeEach")) {
        const setup = hooks.get(scope) ?? [];
        setup.push({ body: node.body, optional: !directHook(registration, scope) });
        hooks.set(scope, setup);
      }
      functions.push(test ? { body: node.body, testScope: scope } : { body: node.body });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const hookClocks = (scope: ts.Node): ClockState => {
    const inherited = scope === source ? new Set<string>() : hookClocks(functionOf(scope.parent));
    return (hooks.get(scope) ?? []).reduce((clocks, { body, optional }) => {
      const prepared = clockFlow(body, clocks);
      return optional ? commonClocks(clocks, prepared) : prepared;
    }, inherited);
  };
  clockFlow(source, new Set(), observe);
  for (const { body, testScope } of functions)
    clockFlow(body, testScope ? hookClocks(testScope) : new Set(), observe);
  return fake;
}

function directHook(call: ts.CallExpression, scope: ts.Node): boolean {
  let statement: ts.Node = call.parent;
  if (!ts.isExpressionStatement(statement)) return false;
  while (ts.isBlock(statement.parent)) statement = statement.parent;
  return statement.parent === scope;
}

function commonClocks(left: ClockState, right: ClockState): ClockState {
  return left === right ? left : new Set([...left].filter((clock) => right.has(clock)));
}

function clockFlow(node: ts.Node, incoming: ClockState, observe?: ObserveClockState): ClockState {
  if (ts.isFunctionLike(node)) return incoming;
  observe?.(node, incoming);
  if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
    const expression = ts.isIfStatement(node) ? node.expression : node.condition;
    const condition = clockFlow(expression, incoming, observe);
    const truthy = ts.isIfStatement(node) ? node.thenStatement : node.whenTrue;
    const falsy = ts.isIfStatement(node) ? node.elseStatement : node.whenFalse;
    return commonClocks(
      clockFlow(truthy, condition, observe),
      falsy === undefined ? condition : clockFlow(falsy, condition, observe),
    );
  }
  if (ts.isTryStatement(node)) {
    let interrupted = incoming;
    const track: ObserveClockState = (child, clocks) => {
      interrupted = commonClocks(interrupted, clocks);
      observe?.(child, clocks);
    };
    const tried = clockFlow(node.tryBlock, incoming, track);
    const continued = node.catchClause
      ? commonClocks(tried, clockFlow(node.catchClause, interrupted, track))
      : tried;
    if (node.finallyBlock === undefined) return continued;
    if (observe) clockFlow(node.finallyBlock, commonClocks(continued, interrupted), observe);
    return clockFlow(node.finallyBlock, continued);
  }
  if (ts.isBinaryExpression(node) && SHORT_CIRCUIT.has(node.operatorToken.kind)) {
    const left = clockFlow(node.left, incoming, observe);
    return commonClocks(left, clockFlow(node.right, left, observe));
  }
  if (ts.isCaseBlock(node)) {
    let preceding = incoming;
    for (const clause of node.clauses)
      preceding = commonClocks(preceding, clockFlow(clause, preceding, observe));
    return preceding;
  }
  if (isLoop(node)) {
    const repeated = commonClocks(incoming, clocksThroughChildren(node, incoming));
    if (observe) clocksThroughChildren(node, repeated, observe);
    return repeated;
  }
  const clocks = clocksThroughChildren(node, incoming, observe);
  return ts.isCallExpression(node) ? clockEffect(node, clocks) : clocks;
}

function clocksThroughChildren(
  node: ts.Node,
  incoming: ClockState,
  observe?: ObserveClockState,
): ClockState {
  let clocks = incoming;
  ts.forEachChild(node, (child) => {
    clocks = clockFlow(child, clocks, observe);
  });
  return clocks;
}

function clockEffect(call: ts.CallExpression, clocks: ClockState): ClockState {
  switch (memberPath(call.expression)?.join(".")) {
    case "vi.useRealTimers":
      return new Set();
    case "vi.setSystemTime":
      return new Set([...clocks, "Date"]);
    case "vi.useFakeTimers": {
      const options = call.arguments[0];
      if (options !== undefined && !ts.isObjectLiteralExpression(options)) return new Set();
      const toFake = options?.properties.find((property) => propertyName(property) === "toFake");
      if (toFake === undefined) return new Set(CLOCKS.values());
      return new Set(
        ts.isPropertyAssignment(toFake) && ts.isArrayLiteralExpression(toFake.initializer)
          ? toFake.initializer.elements.filter(ts.isStringLiteral).map((element) => element.text)
          : [],
      );
    }
    default:
      return clocks;
  }
}

function budgetsIn(
  node: ts.Expression,
  runnerConfig: boolean,
  found: (property: ts.Node) => void,
): void {
  if (!ts.isObjectLiteralExpression(node)) return;
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (BUDGET_KEYS.has(property.name.text)) found(property);
    } else if (ts.isPropertyAssignment(property)) {
      const value = property.initializer;
      if (BUDGET_KEYS.has(propertyName(property) ?? "")) {
        if (isConstantNumber(value) || ts.isIdentifier(value)) found(property);
      } else if (runnerConfig) budgetsIn(value, runnerConfig, found);
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

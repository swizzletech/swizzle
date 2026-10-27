import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UserConsoleLog } from "vitest";
import type { Reporter, SerializedError, TestModule, TestRunEndReason, Vitest } from "vitest/node";

/**
 * Writes the whole run (every module, suite and test, its errors and its console output) to
 * `vitest.log` in the run directory, so the terminal reporter can stay terse.
 * A red run keeps the directory with the state its tests left and prints the
 * log path as the last line; a green run deletes the directory.
 */
export class TestRunReporter implements Reporter {
  private readonly consoleLogs: UserConsoleLog[] = [];
  private vitest: Vitest | undefined;

  constructor(private readonly runDirectory: string) {}

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    this.consoleLogs.push(log);
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    if (reason === "passed" && unhandledErrors.length === 0) {
      rmSync(this.runDirectory, { force: true, recursive: true });
      return;
    }

    const root = this.vitest?.config.root ?? process.cwd();
    const lines: string[] = [];
    const logsFor = (taskId: string | undefined) =>
      this.consoleLogs
        .filter((log) => log.taskId === taskId)
        .map((log) => indent(`[${log.type}] ${log.content.trimEnd()}`, 4));

    for (const testModule of testModules) {
      lines.push(`${testModule.state()} ${path.relative(root, testModule.moduleId)}`);
      lines.push(...testModule.errors().map((error) => indent(formatError(error), 2)));
      lines.push(...logsFor(testModule.id));
      // A suite-level hook reports its errors and console output on the suite, not a test.
      for (const suite of testModule.children.allSuites()) {
        const suiteLines = [
          ...suite.errors().map((error) => indent(formatError(error), 4)),
          ...logsFor(suite.id),
        ];
        if (suiteLines.length > 0) lines.push(`  suite ${suite.fullName}`, ...suiteLines);
      }
      for (const test of testModule.children.allTests()) {
        const result = test.result();
        const duration = test.diagnostic()?.duration;
        lines.push(
          `  ${result.state} ${test.fullName}${duration === undefined ? "" : ` (${Math.round(duration)} ms)`}`,
        );
        lines.push(...(result.errors ?? []).map((error) => indent(formatError(error), 4)));
        lines.push(...logsFor(test.id));
      }
    }
    lines.push(...logsFor(undefined));
    if (unhandledErrors.length > 0) {
      lines.push("unhandled errors");
      lines.push(...unhandledErrors.map((error) => indent(formatError(error), 2)));
    }

    const logPath = path.join(this.runDirectory, "vitest.log");
    mkdirSync(this.runDirectory, { recursive: true });
    writeFileSync(logPath, `${lines.join("\n")}\n`);
    this.vitest?.logger.log(`Full log: ${logPath}`);
  }
}

function formatError(error: SerializedError): string {
  const heading = `${error.name ?? "Error"}: ${error.message}`;
  const stack = error.stack?.includes(error.message)
    ? error.stack
    : `${heading}\n${error.stack ?? ""}`;
  return typeof error.diff === "string" ? `${stack}\n${error.diff}` : stack;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

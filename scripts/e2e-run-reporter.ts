import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";

/**
 * Owns the run's output directory: a green run deletes it. A red run keeps the traces and
 * screenshots there, writes e2e.log with every test result, error and line the tests and the
 * web server printed, and prints both paths last.
 */
export default class E2eRunReporter implements Reporter {
  private outputDirectory: string | undefined;
  private status: FullResult["status"] = "failed";
  private readonly log: string[] = [];

  onBegin(config: FullConfig): void {
    this.outputDirectory = config.projects[0]?.outputDir;
  }

  onStdOut(chunk: string | Buffer, test?: TestCase): void {
    this.record("stdout", chunk, test);
  }

  onStdErr(chunk: string | Buffer, test?: TestCase): void {
    this.record("stderr", chunk, test);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.log.push(`${result.status} ${title(test)} (${result.duration} ms)`);
    for (const error of result.errors) this.log.push(formatError(error));
  }

  onError(error: TestError): void {
    this.log.push(`error outside a test\n${formatError(error)}`);
  }

  onEnd(result: FullResult): void {
    this.status = result.status;
  }

  async onExit(): Promise<void> {
    const outputDirectory = this.outputDirectory;
    if (outputDirectory === undefined) return;
    if (this.status === "passed") {
      // Playwright writes .last-run.json after onExit, so delete on process exit.
      process.once("exit", () => rmSync(outputDirectory, { force: true, recursive: true }));
      return;
    }
    const logPath = path.join(outputDirectory, "e2e.log");
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(logPath, `${this.log.join("\n")}\n`);
    process.stdout.write(`Traces and screenshots: ${outputDirectory}\nFull log: ${logPath}\n`);
  }

  printsToStdio(): boolean {
    return false;
  }

  private record(stream: "stderr" | "stdout", chunk: string | Buffer, test?: TestCase): void {
    const source = test === undefined ? stream : `${stream} ${title(test)}`;
    this.log.push(`[${source}] ${stripVTControlCharacters(chunk.toString()).trimEnd()}`);
  }
}

function title(test: TestCase): string {
  return test.titlePath().filter(Boolean).join(" > ");
}

function formatError(error: TestError): string {
  const text = error.stack ?? error.message ?? error.value ?? "unknown error";
  return stripVTControlCharacters(text)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

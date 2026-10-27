import path from "node:path";
import type { Rule } from "../lint.js";

/** The files `cp` reads: every operand but the last, or all of them with `-t <dir>`. */
function cpSources(args: readonly string[]): string[] {
  const operands: string[] = [];
  let target = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") operands.push(arg);
    else if (arg === "-t" || arg === "-S") {
      target ||= arg === "-t";
      index += 1;
    } else target ||= arg.startsWith("--target-directory") || /^-[^-]*t/u.test(arg);
  }
  return target ? operands : operands.slice(0, -1);
}

export const noEnvExampleCopy: Rule = {
  id: "no-env-example-copy",
  check(repo) {
    return repo
      .commands()
      .filter(
        ({ words: [name, ...args] }) =>
          name === "cp" &&
          cpSources(args).some((source) => path.posix.basename(source) === ".env.example"),
      )
      .map(({ file, line }) => ({
        file,
        line,
        message:
          "Copying .env.example leaves every credential blank. `just init-env` writes .env with fresh credentials.",
      }));
  },
};

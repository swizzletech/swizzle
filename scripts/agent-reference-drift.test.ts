import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkInvocation, createProgram, describeCommandTree, runCli } from "@swizzle/cli";
import { describe, expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { shellCommands } from "./conventions/parse.js";
import { gitRepo, readRepo } from "./conventions/repo.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

// Decisions and declined requests record what was true when they were written; they stay as they
// are. The CLI reference is generated from the command tree, so it cannot drift.
const EXEMPT = /^(docs\/adr\/|\.out-of-scope\/|docs\/reference\/cli\.md$)/u;

describe("agent reference drift", () => {
  it("teaches only commands and flags the CLI accepts", async () => {
    const program = createProgram();
    const pages = gitRepo(repoRoot).files.filter(
      (file) => file.endsWith(".md") && !EXEMPT.test(file),
    );
    const workspace = await temporaryDirectory("swizzle-reference-workspace-");
    const output: string[] = [];
    const exitCode = await runCli(["workspace", "init", workspace], {
      stdout: (message) => output.push(message),
      stderr: (message) => output.push(message),
    });
    expect(exitCode, output.join("\n")).toBe(0);
    const guides = (await readdir(workspace, { recursive: true })).filter(
      (file) => file.endsWith(".md") || file.endsWith(".sh"),
    );
    const unknown = [...cliCommands(repoRoot, pages), ...cliCommands(workspace, guides)].flatMap(
      ({ file, line, words }) => {
        const { problem } = checkInvocation(program, words.slice(1));
        return problem === null ? [] : [`${file}:${line}: \`${words.join(" ")}\` (${problem})`];
      },
    );

    expect(unknown).toEqual([]);
  });

  it("gives every command examples the CLI accepts", () => {
    const program = createProgram();
    type Node = ReturnType<typeof describeCommandTree>["commands"][number];
    const walk = (node: Node): Node[] => [node, ...node.subcommands.flatMap(walk)];
    const nodes = describeCommandTree(program).commands.flatMap(walk);
    const problems = nodes.flatMap((node) => {
      const name = node.path.join(" ");
      if (node.examples.length === 0) return [`${name}: no examples`];
      return node.examples.flatMap((example) =>
        shellCommands(example.replace(/<([A-Za-z][\w.|-]*)>/gu, "$1"))
          .filter(({ words }) => words[0] === "swizzle")
          .flatMap(({ words }) => {
            const { problem } = checkInvocation(program, words.slice(1));
            return problem === null ? [] : [`${name}: \`${example}\` (${problem})`];
          }),
      );
    });

    expect(problems).toEqual([]);
  });
});

// Every `swizzle` command in Markdown code or a generated shell script, as the shell splits it.
// The verify skill drives the CLI as `$V/swizzle`.
function cliCommands(root: string, pages: readonly string[]) {
  return readRepo(root, pages)
    .commands()
    .filter(
      ({ words }) =>
        (words[0] === "swizzle" || words[0]?.endsWith("/swizzle") === true) &&
        /^[a-z-]/u.test(words[1] ?? ""),
    );
}

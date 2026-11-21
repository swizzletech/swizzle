import type { Repo } from "./repo.js";

export interface Violation {
  readonly file: string;
  readonly line: number;
  /** Says what is wrong and why the rule exists. */
  readonly message: string;
}

/** One repository convention. */
export interface Rule {
  readonly id: string;
  readonly allowInlineException?: false;
  check(repo: Repo, notice: (message: string) => void): Violation[];
}

export type Finding = Violation & { readonly rule: string };

const HATCH = /conventions-allow ([\w-]+): *[A-Za-z]/u;

/**
 * Runs the rules and drops each violation that `conventions-allow <rule-id>: <reason>` covers,
 * on the violation's line or the line above it.
 */
export function lint(
  repo: Repo,
  rules: readonly Rule[],
  notice: (message: string) => void = () => {},
): Finding[] {
  return rules.flatMap((rule) =>
    rule
      .check(repo, notice)
      .filter(({ file, line }) => {
        if (rule.allowInlineException === false || !repo.exists(file)) return true;
        const text = repo.read(file).split("\n");
        return ![text[line - 1], text[line - 2]].some(
          (near) => near?.match(HATCH)?.[1] === rule.id,
        );
      })
      .map((violation) => ({ ...violation, rule: rule.id })),
  );
}

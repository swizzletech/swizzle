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
  check(repo: Repo): Violation[];
}

export type Finding = Violation & { readonly rule: string };

const HATCH = /conventions-allow ([\w-]+): *[A-Za-z]/u;

/**
 * Runs the rules and drops each violation that `conventions-allow <rule-id>: <reason>` covers,
 * on the violation's line or the line above it.
 */
export function lint(repo: Repo, rules: readonly Rule[]): Finding[] {
  return rules.flatMap((rule) =>
    rule
      .check(repo)
      .filter(({ file, line }) => {
        if (!repo.exists(file)) return true;
        const text = repo.read(file).split("\n");
        return ![text[line - 1], text[line - 2]].some(
          (near) => near?.match(HATCH)?.[1] === rule.id,
        );
      })
      .map((violation) => ({ ...violation, rule: rule.id })),
  );
}

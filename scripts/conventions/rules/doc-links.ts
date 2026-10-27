import path from "node:path";
import { lexer, walkTokens } from "marked";
import type { Rule, Violation } from "../lint.js";

// A label containing one code-formatted identifier names a symbol in the target file.
const symbolLabel = /^`([A-Za-z_$][\w$]*)`$/u;

function links(markdown: string): { label: string; href: string; line: number }[] {
  const found: { label: string; href: string; line: number }[] = [];
  let start = 0;
  for (const block of lexer(markdown)) {
    let cursor = start;
    walkTokens([block], (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      const offset = markdown.indexOf(token.raw, cursor);
      const at = offset < 0 ? start : offset;
      cursor = at + token.raw.length;
      found.push({
        label: token.type === "image" ? "" : token.text,
        href: token.href,
        line: markdown.slice(0, at).split("\n").length,
      });
    });
    start += block.raw.length;
  }
  return found;
}

export const docLinks: Rule = {
  id: "doc-links",
  check(repo) {
    const markdown = repo.files.filter((file) => file.endsWith(".md"));
    const broken = markdown.flatMap((file) =>
      links(repo.read(file)).flatMap(({ label, href, line }): Violation[] => {
        const target = href.split("#")[0] ?? "";
        if (target === "" || /^[a-z]+:/u.test(target)) return [];
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), target).replace(/\/$/u, ""),
        );
        if (!repo.exists(resolved === "." ? "" : resolved))
          return [{ file, line, message: `Link target ${target} does not exist.` }];
        const symbol = symbolLabel.exec(label)?.[1];
        if (symbol === undefined || !repo.files.includes(resolved)) return [];
        const defined = new RegExp(`(?<![\\w$])${symbol.replaceAll("$", "\\$")}(?![\\w$])`, "u");
        return defined.test(repo.read(resolved))
          ? []
          : [{ file, line, message: `${target} does not contain \`${symbol}\`.` }];
      }),
    );
    const index = "docs/README.md";
    const indexed = new Set(
      repo.exists(index)
        ? links(repo.read(index)).map(({ href }) =>
            path.posix.join("docs", href.split("#")[0] ?? ""),
          )
        : [],
    );
    const missing = markdown.filter(
      (file) =>
        file.startsWith("docs/") &&
        file !== index &&
        !file.startsWith("docs/adr/") &&
        !indexed.has(file),
    );
    return [
      ...broken,
      ...missing.map((file) => ({
        file,
        line: 1,
        message: `${file} has no link in docs/README.md.`,
      })),
    ];
  },
};

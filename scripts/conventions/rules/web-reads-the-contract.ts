import path from "node:path";
import ts from "typescript";
import type { Rule, Violation } from "../lint.js";
import type { Repo } from "../repo.js";

const CONTRACT = "packages/runtime/src/http-contract.ts";
const REQUEST = "apps/web/src/lib/api/request.ts";
const CALLS = /^apps\/web\/src\/lib\/api\/[^/]+\.ts$/u;

// The dashboard reads every API answer as the type its route declares in the HTTP contract, so a
// changed response fails the dashboard's type check. A shape written in the dashboard instead
// compiles against whatever the API stops sending.
export const webReadsTheContract: Rule = {
  id: "web-reads-the-contract",
  check(repo) {
    const files = repo.files.filter((file) => CALLS.test(file));
    const program = contractProgram(repo, [...files, CONTRACT]);
    const checker = program.getTypeChecker();
    const origin = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
      symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    const exportsOf = (file: string): ts.Symbol[] => {
      const source = program.getSourceFile(`/${file}`);
      const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
      return symbol === undefined ? [] : checker.getExportsOfModule(symbol);
    };
    const request = origin(exportsOf(REQUEST).find((symbol) => symbol.name === "request"));
    if (request === undefined) return [];
    const exported = new Set(
      exportsOf(CONTRACT).flatMap((symbol) => {
        const resolved = origin(symbol);
        return resolved !== undefined && (resolved.flags & ts.SymbolFlags.Type) !== 0
          ? [resolved]
          : [];
      }),
    );
    const violations: Violation[] = [];
    for (const file of files) {
      const source = program.getSourceFile(`/${file}`);
      if (source === undefined) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          origin(checker.getSymbolAtLocation(node.expression)) === request
        ) {
          const type = node.typeArguments?.[0];
          const symbol =
            type !== undefined && ts.isTypeReferenceNode(type) && type.typeArguments === undefined
              ? origin(checker.getSymbolAtLocation(type.typeName))
              : undefined;
          // `unknown` reads nothing of the answer, so it describes no shape.
          const allowed =
            node.typeArguments?.length === 1 &&
            (type?.kind === ts.SyntaxKind.UnknownKeyword ||
              (symbol !== undefined && exported.has(symbol)));
          if (!allowed) {
            const named =
              type === undefined
                ? "request() names no response type"
                : `request<${type.getText(source)}> names no export of ${CONTRACT}`;
            violations.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              message: `${named}. Name the Reply type the route declares there, re-exported through apps/web/src/lib/api.ts; when the route has none, add it to the contract and to the route. Use request<unknown> only for an answer the dashboard never reads.`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return violations;
  },
};

/** Resolves the rule's source graph from Repo, including workspace package exports. */
function contractProgram(repo: Repo, files: readonly string[]): ts.Program {
  // A virtual node_modules symlink lets TypeScript read each workspace package's own exports.
  // Both the real checkout and planted fixtures resolve solely through Repo, never host files.
  const repoPath = (file: string): string => {
    const relative = path.posix.relative("/", file);
    if (relative === "node_modules" || relative === "node_modules/@swizzle") return "packages";
    return relative.startsWith("node_modules/@swizzle/")
      ? `packages/${relative.slice("node_modules/@swizzle/".length)}`
      : relative;
  };
  const read = (file: string): string | undefined => {
    const relative = repoPath(file);
    return repo.exists(relative) ? repo.read(relative) : undefined;
  };
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["swizzle-source"],
    noLib: true,
    noEmit: true,
  };
  return ts.createProgram(
    files.map((file) => `/${file}`),
    options,
    {
      getSourceFile: (file, languageVersion) => {
        const text = read(file);
        return text === undefined
          ? undefined
          : ts.createSourceFile(file, text, languageVersion, true);
      },
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "/",
      getCanonicalFileName: (file) => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (file) => repo.exists(repoPath(file)),
      directoryExists: (file) => repo.exists(repoPath(file)),
      realpath: (file) => `/${repoPath(file)}`,
      readFile: read,
    },
  );
}

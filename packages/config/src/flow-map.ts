// The convention that joins an automation's code to its flow.mermaid: a flowchart node whose id
// equals a step name in the entrypoint is a station the dashboard can light up during a run. This
// module finds both sides without a parser dependency: the durable step call sites in an entrypoint
// (`runStep("key", …)` and the wait helpers, in TypeScript, JavaScript and Python) and the node ids
// of a Mermaid flowchart. `swizzle validate` compares them and warns; deploy scans the entrypoint
// into its snapshot for the dashboard. Both are display data: a miss shows as unmapped, never as an error.

/** What a step call site waits for, from the helper that declares it. */
export type StepKind = "step" | "sleep" | "child" | "event" | "approval";

/** One durable step call in an entrypoint, with the lines it spans. */
export interface StepSite {
  readonly key: string;
  readonly kind: StepKind;
  /** 1-based line of the helper call. */
  readonly startLine: number;
  /** 1-based line of the call's closing parenthesis. */
  readonly endLine: number;
  /** The literal automation name an `invokeAutomation` call targets; null for the other kinds. */
  readonly target: string | null;
}

export type StepSourceLanguage = "node" | "python";

/** The scanner's language for a config `runtime.language`; TypeScript and JavaScript scan as node. */
export function stepSourceLanguage(language: unknown): StepSourceLanguage {
  return language === "python" ? "python" : "node";
}

const HELPERS: Readonly<Record<StepSourceLanguage, Readonly<Record<string, StepKind>>>> = {
  node: {
    invokeAutomation: "child",
    requestApproval: "approval",
    runStep: "step",
    sleep: "sleep",
    sleepUntil: "sleep",
    waitForEvent: "event",
  },
  python: {
    invoke_automation: "child",
    request_approval: "approval",
    run_step: "step",
    sleep: "sleep",
    sleep_until: "sleep",
    wait_for_event: "event",
  },
};

/**
 * The step call sites of one entrypoint, in source order. A call whose first argument is not a
 * string literal is skipped: its key is only known at run time.
 */
export function scanStepSites(language: StepSourceLanguage, source: string): readonly StepSite[] {
  const helpers = HELPERS[language];
  const lexer = new Lexer(language, source);
  const sites: StepSite[] = [];

  while (!lexer.done()) {
    if (lexer.skipCommentOrString()) continue;
    const word = lexer.readWord();
    if (word === null) {
      lexer.advance();
      continue;
    }
    const kind = Object.hasOwn(helpers, word) ? helpers[word] : undefined;
    if (kind === undefined || !lexer.wordStandsAlone(word)) continue;
    const startLine = lexer.lineAt(lexer.index - word.length);
    lexer.skipSpace();
    if (lexer.peek() !== "(") continue;
    lexer.advance();
    lexer.skipSpace();
    const key = lexer.readStringArgument();
    if (key === null) continue;
    const target = kind === "child" ? lexer.readSecondStringArgument() : null;
    // The scan goes on inside the arguments, so a call nested in a step's callback is found too.
    const endIndex = lexer.closingParenIndex();
    sites.push({ endLine: lexer.lineAt(endIndex), key, kind, startLine, target });
  }
  return sites;
}

/** A single pass over the source that knows where comments and strings start and end. */
class Lexer {
  index = 0;
  private readonly lineStarts: number[] = [0];

  constructor(
    private readonly language: StepSourceLanguage,
    private readonly source: string,
  ) {
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === "\n") this.lineStarts.push(i + 1);
    }
  }

  done(): boolean {
    return this.index >= this.source.length;
  }

  peek(offset = 0): string {
    return this.source[this.index + offset] ?? "";
  }

  advance(count = 1): void {
    this.index += count;
  }

  lineAt(index: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  skipSpace(): void {
    while (!this.done() && /\s/u.test(this.peek())) this.advance();
  }

  /** Skips a comment or a string that starts here; false when the position is code. */
  skipCommentOrString(): boolean {
    const char = this.peek();
    if (this.language === "python") {
      if (char === "#") return this.skipToLineEnd();
      if (char === '"' || char === "'") return this.skipPythonString();
      return false;
    }
    if (char === "/" && this.peek(1) === "/") return this.skipToLineEnd();
    if (char === "/" && this.peek(1) === "*") {
      const end = this.source.indexOf("*/", this.index + 2);
      this.index = end === -1 ? this.source.length : end + 2;
      return true;
    }
    if (char === "/" && this.regexCanStartHere()) {
      this.skipRegex();
      return true;
    }
    if (char === '"' || char === "'" || char === "`") {
      this.skipQuoted(char);
      return true;
    }
    return false;
  }

  /** A `/` after a value divides; after an operator, a delimiter or nothing it opens a regex. */
  private regexCanStartHere(): boolean {
    const before = this.source.slice(Math.max(0, this.index - 80), this.index).trimEnd();
    const last = before[before.length - 1];
    if (last === undefined) return true;
    if (/[\w$)\]]/u.test(last)) return /(?:return|typeof|case|in|of|delete|void)$/u.test(before);
    return true;
  }

  /** Skips a regex literal with its escapes, character classes and flags. */
  private skipRegex(): void {
    this.advance();
    let inClass = false;
    while (!this.done()) {
      const char = this.peek();
      if (char === "\\") {
        this.advance(2);
        continue;
      }
      if (char === "\n") return;
      this.advance();
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
    }
    while (!this.done() && /[a-z]/u.test(this.peek())) this.advance();
  }

  private skipToLineEnd(): boolean {
    const end = this.source.indexOf("\n", this.index);
    this.index = end === -1 ? this.source.length : end;
    return true;
  }

  private skipPythonString(): boolean {
    const quote = this.peek();
    if (this.peek(1) === quote && this.peek(2) === quote) {
      const end = this.source.indexOf(quote.repeat(3), this.index + 3);
      this.index = end === -1 ? this.source.length : end + 3;
      return true;
    }
    this.skipQuoted(quote);
    return true;
  }

  /** Skips a quoted string including its escapes; a template literal's `${…}` is skipped by brackets. */
  private skipQuoted(quote: string): void {
    this.advance();
    while (!this.done()) {
      const char = this.peek();
      if (char === "\\") {
        this.advance(2);
        continue;
      }
      if (char === quote) {
        this.advance();
        return;
      }
      if (quote === "`" && char === "$" && this.peek(1) === "{") {
        this.advance(2);
        this.skipBalanced("}");
        continue;
      }
      if (quote !== "`" && char === "\n") return;
      this.advance();
    }
  }

  /** Reads an identifier at the position, or null when the position is not a word start. */
  readWord(): string | null {
    const match = /^[A-Za-z_$][\w$]*/u.exec(this.source.slice(this.index, this.index + 80));
    if (match === null) return null;
    const word = match[0];
    this.advance(word.length);
    // A Python string prefix such as f"…" or r'…' is not a word; skip the string behind it.
    if (this.language === "python" && /^[rbuf]{1,2}$/iu.test(word)) {
      const next = this.peek();
      if (next === '"' || next === "'") {
        this.skipPythonString();
        return null;
      }
    }
    return word;
  }

  /** The word is a helper call, not a property of something else or a definition of the helper. */
  wordStandsAlone(word: string): boolean {
    const before = this.source.slice(0, this.index - word.length);
    const previous = before.trimEnd();
    if (previous.endsWith(".")) {
      // `swizzle.runStep(…)` and `sdk.runStep(…)` count; `foo.bar.runStep` does too.
      return true;
    }
    return !/(?:function|def|async\s+def)\s*$/u.test(previous);
  }

  /** A string literal that is the whole argument; null when the key is built at run time. */
  readStringArgument(): string | null {
    const literal = this.readStringLiteral();
    if (literal === null) return null;
    const after = this.index;
    this.skipSpace();
    const next = this.peek();
    this.index = after;
    return next === "," || next === ")" ? literal : null;
  }

  /** A plain string literal at the position, decoded; null for anything else, such as a variable. */
  readStringLiteral(): string | null {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'" && !(quote === "`" && this.language === "node")) return null;
    if (this.language === "python" && this.peek(1) === quote && this.peek(2) === quote) return null;
    let value = "";
    let i = this.index + 1;
    while (i < this.source.length) {
      const char = this.source[i] ?? "";
      if (char === "\\") {
        const escaped = decodeEscape(this.source, i);
        if (escaped === null) return null;
        value += escaped.value;
        i += escaped.length;
        continue;
      }
      if (char === quote) {
        this.index = i + 1;
        return value;
      }
      if (quote === "`" && char === "$" && this.source[i + 1] === "{") return null;
      if (char === "\n" && quote !== "`") return null;
      value += char;
      i += 1;
    }
    return null;
  }

  /** After the first argument: the second argument when it is a string literal. */
  readSecondStringArgument(): string | null {
    this.skipSpace();
    if (this.peek() !== ",") return null;
    this.advance();
    this.skipSpace();
    return this.readStringArgument();
  }

  /** Where the call whose `(` was already consumed closes, without moving the scan there. */
  closingParenIndex(): number {
    const start = this.index;
    this.skipBalanced(")");
    const end = Math.max(this.index - 1, 0);
    this.index = start;
    return end;
  }

  private skipBalanced(closer: string): void {
    let depth = 0;
    while (!this.done()) {
      if (this.skipCommentOrString()) continue;
      const char = this.peek();
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") {
        if (depth === 0 && char === closer) {
          this.advance();
          return;
        }
        depth -= 1;
      }
      this.advance();
    }
  }
}

/**
 * One escape sequence at `index` (a backslash), as the language reads it; null for one the scan
 * does not decode, so the key is skipped rather than mapped to the wrong name.
 */
function decodeEscape(source: string, index: number): { value: string; length: number } | null {
  const next = source[index + 1] ?? "";
  const simple: Readonly<Record<string, string>> = {
    '"': '"',
    "'": "'",
    "0": "\0",
    "\\": "\\",
    "`": "`",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  };
  if (Object.hasOwn(simple, next)) return { length: 2, value: simple[next] ?? "" };
  if (next === "x" && /^[0-9a-f]{2}$/iu.test(source.slice(index + 2, index + 4))) {
    return {
      length: 4,
      value: String.fromCodePoint(Number.parseInt(source.slice(index + 2, index + 4), 16)),
    };
  }
  if (next === "u") {
    const braced = /^\{([0-9a-f]{1,6})\}/iu.exec(source.slice(index + 2, index + 10));
    if (braced !== null) {
      return {
        length: 3 + braced[0].length - 1,
        value: String.fromCodePoint(Number.parseInt(braced[1] ?? "0", 16)),
      };
    }
    if (/^[0-9a-f]{4}$/iu.test(source.slice(index + 2, index + 6))) {
      return {
        length: 6,
        value: String.fromCodePoint(Number.parseInt(source.slice(index + 2, index + 6), 16)),
      };
    }
  }
  if (next === "\n") return { length: 2, value: "" };
  return null;
}

// Node ids for drift checks in the CLI and dashboard. A statement names nodes by
// id, each optionally followed by a shape bracket with a label, joined by arrows that may carry a
// label. Everything in brackets, pipes and quotes is text, not an id.

const FLOWCHART_HEADER = /^\s*(?:flowchart|graph)\b(?:\s+(?:TB|TD|BT|LR|RL)\b)?/u;
const LINE_KEYWORDS = /^\s*(?:subgraph|end|style|classDef|class|click|linkStyle|direction)\b/u;
const ID_CHARS = /[\w-]/u;
const BRACKET_CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };

/** The node ids a Mermaid flowchart declares, in order of first appearance; empty for other diagrams. */
export function extractFlowNodeIds(mermaid: string): readonly string[] {
  const lines = mermaid
    .replace(/^\s*---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "")
    .split("\n")
    .map(stripMermaidComment);
  const headerIndex = lines.findIndex((line) => line.trim() !== "");
  const header = lines[headerIndex] ?? "";
  const match = FLOWCHART_HEADER.exec(header);
  if (match === null) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  lines[headerIndex] = header.slice(match[0].length);
  for (const line of lines.slice(headerIndex).flatMap(mermaidStatements)) {
    if (LINE_KEYWORDS.test(line)) continue;
    for (const id of nodeIdsOnLine(line)) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

/** Semicolons inside shapes or labels belong to their text, not to the statement boundary. */
function mermaidStatements(line: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < line.length) {
    const char = line[i] ?? "";
    if (char === '"' || char === "|") i = skipPast(line, i + 1, char);
    else if (char in BRACKET_CLOSERS) i = skipBrackets(line, i);
    else if (char === "-" || char === "=" || char === ".") i = skipArrow(line, i);
    else {
      if (char === ";") {
        statements.push(line.slice(start, i));
        start = i + 1;
      }
      i += 1;
    }
  }
  statements.push(line.slice(start));
  return statements;
}

function stripMermaidComment(line: string): string {
  let i = 0;
  while (i < line.length) {
    const char = line[i] ?? "";
    if (char === '"' || char === "|") i = skipPast(line, i + 1, char);
    else if (char in BRACKET_CLOSERS) i = skipBrackets(line, i);
    else if (line.startsWith("%%", i)) return line.slice(0, i);
    else i += 1;
  }
  return line;
}

function nodeIdsOnLine(line: string): readonly string[] {
  const ids: string[] = [];
  let i = 0;
  while (i < line.length) {
    const char = line[i] ?? "";
    if (char === '"') {
      i = skipPast(line, i + 1, '"');
    } else if (char === "|") {
      i = skipPast(line, i + 1, "|");
    } else if (char in BRACKET_CLOSERS) {
      i = skipBrackets(line, i);
    } else if (char === "@" && line[i + 1] === "{") {
      i = skipBrackets(line, i + 1);
    } else if (char === ":" && line.startsWith(":::", i)) {
      i += 3;
      while (i < line.length && ID_CHARS.test(line[i] ?? "")) i += 1;
    } else if (char === "-" || char === "=" || char === ".") {
      i = skipArrow(line, i);
    } else if (/[A-Za-z0-9_]/u.test(char)) {
      let end = i;
      while (end < line.length && ID_CHARS.test(line[end] ?? "")) {
        // `a-->b` : the id ends where an arrow starts.
        if (line[end] === "-" && (line[end + 1] === "-" || line[end + 1] === ">")) break;
        end += 1;
      }
      ids.push(line.slice(i, end));
      i = end;
    } else {
      i += 1;
    }
  }
  return ids;
}

function skipPast(line: string, from: number, closer: string): number {
  const index = line.indexOf(closer, from);
  return index === -1 ? line.length : index + 1;
}

/** Skips a shape such as `[label]`, `([label])`, `{{label}}` or `[/label/]`, quotes included. */
function skipBrackets(line: string, from: number): number {
  const stack: string[] = [];
  let i = from;
  while (i < line.length) {
    const char = line[i] ?? "";
    if (char === '"') {
      i = skipPast(line, i + 1, '"');
      continue;
    }
    if (char in BRACKET_CLOSERS) stack.push(BRACKET_CLOSERS[char] ?? "");
    else if (char === stack[stack.length - 1]) stack.pop();
    i += 1;
    if (stack.length === 0) return i;
  }
  return i;
}

/** Skips an arrow and its inline label: `-->`, `-.->`, `==>`, `-- text -->`, `-- text ---`. */
function skipArrow(line: string, from: number): number {
  let i = from;
  while (i < line.length && /[-=.<]/u.test(line[i] ?? "")) i += 1;
  // One head at most: `-->`, `--x`, `--o`; the next character already belongs to the node id.
  if (i < line.length && /[>xo]/u.test(line[i] ?? "")) i += 1;
  const arrow = line.slice(from, i);
  // `--` or `==` or `-.` without a head opens a label that the next arrow closes.
  if (/^(?:--|==|-\.)$/u.test(arrow)) {
    const rest = line.slice(i);
    const close = /(?:-->|---|-\.->|-\.-|==>|===)/u.exec(rest);
    return close === null ? line.length : i + close.index + close[0].length;
  }
  return i;
}

export interface FlowDriftWarning {
  /** The step key without a node. */
  readonly id: string;
  readonly message: string;
}

/**
 * Where the flow and the code disagree: a step the entrypoint calls that no node of flow.mermaid
 * names, so the dashboard cannot light it. A node without a step is narration, such as a trigger
 * or a decision, and never drifts.
 */
export function flowDrift(
  nodeIds: readonly string[],
  sites: readonly StepSite[],
): readonly FlowDriftWarning[] {
  const nodes = new Set(nodeIds);
  return sites
    .filter((site) => !nodes.has(site.key))
    .map((site) => ({
      id: site.key,
      message: `step "${site.key}" (line ${site.startLine}) has no node of that id in flow.mermaid; the dashboard cannot light it up.`,
    }));
}

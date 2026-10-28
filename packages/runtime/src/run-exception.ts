/** The last Python traceback or Node exception in stderr, with its innermost source location. */
export interface RunException {
  readonly message: string;
  readonly location: string | null;
}

type ExceptionContext =
  | { readonly kind: "none" }
  | { readonly kind: "python"; readonly location: string | null }
  | {
      readonly kind: "node";
      readonly location: string;
      readonly phase: "source" | "value" | "complete";
    };

export function findRunException(stderr: string): RunException | null {
  let exception: RunException | null = null;
  let context: ExceptionContext = { kind: "none" };
  for (const line of stderr.split(/\r?\n/u)) {
    if (line.startsWith("Traceback (most recent call last):")) {
      context = { kind: "python", location: null };
      exception = null;
      continue;
    }
    const pythonFrame = /^\s*File "([^"]+)", line (\d+)/u.exec(line);
    if (context.kind === "python" && pythonFrame) {
      context = { kind: "python", location: location(pythonFrame[1] ?? "", pythonFrame[2] ?? "") };
      continue;
    }
    if (context.kind === "node" && context.phase === "value" && line.trim() !== "") {
      exception = { message: line.trim(), location: context.location };
      context = { kind: "node", location: context.location, phase: "complete" };
      continue;
    }
    if (
      /^[\w.]*(?:Error|Exception|Interrupt|Exit|Fault)(?::.*)?$/u.test(line) ||
      (context.kind === "python" && /^[\w.]+(?::.*)?$/u.test(line))
    ) {
      exception = {
        message: line.trim(),
        location: context.kind === "none" ? null : context.location,
      };
      context =
        context.kind === "node"
          ? { kind: "node", location: context.location, phase: "complete" }
          : { kind: "none" };
      continue;
    }
    const nodeSource = /^(\S.*?):(\d+)(?::\d+)?$/u.exec(line);
    if (nodeSource) {
      context = {
        kind: "node",
        location: location(nodeSource[1] ?? "", nodeSource[2] ?? ""),
        phase: "source",
      };
      continue;
    }
    if (context.kind === "node" && context.phase === "source" && /^\s*\^+\s*$/u.test(line)) {
      context = { kind: "node", location: context.location, phase: "value" };
      continue;
    }
    // Node's first stack frame is the point that threw, subsequent frames are its callers.
    const nodeFrame = /^\s+at (.+):(\d+):\d+\)?\s*$/u.exec(line);
    if (exception && exception.location === null && nodeFrame) {
      const frame = nodeFrame[1] ?? "";
      const opening = frame.indexOf("(");
      const file = opening >= 0 && opening < frame.length - 1 ? frame.slice(opening + 1) : frame;
      exception = { ...exception, location: location(file, nodeFrame[2] ?? "") };
    }
  }
  return exception;
}

export function exceptionSummary(exception: RunException): string {
  return exception.location === null
    ? exception.message
    : `${exception.message} at ${exception.location}`;
}

function location(file: string, line: string): string {
  return `${file.split(/[/\\]/u).at(-1) ?? file}:${line}`;
}

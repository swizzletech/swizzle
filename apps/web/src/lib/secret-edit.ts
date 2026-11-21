export interface Selection {
  readonly end: number;
  readonly start: number;
}

export type SecretEdit =
  | { readonly kind: "typed"; readonly inputType: string; readonly text: string }
  | { readonly kind: "composed"; readonly text: string }
  | { readonly kind: "filled"; readonly shown: string };

export interface EditResult {
  readonly caret: number;
  readonly value: string;
}

export const MASK = "•";

export function characters(text: string): string[] {
  return Array.from(text);
}

export function applyEdit(
  value: string,
  selection: Selection,
  edit: SecretEdit,
): EditResult | null {
  const length = characters(value).length;
  const { end, start } = selection;
  if (edit.kind === "composed") return replace(value, start, end, edit.text);
  if (edit.kind === "filled") return filled(value, edit.shown, end);
  const { inputType, text } = edit;
  if (inputType.startsWith("insert")) return replace(value, start, end, text);
  if (start !== end && inputType.startsWith("delete")) return replace(value, start, end, "");
  if (inputType === "deleteContentBackward") return replace(value, start - 1, start, "");
  if (inputType === "deleteContentForward") return replace(value, start, start + 1, "");
  if (inputType.startsWith("delete") && inputType.endsWith("Backward")) {
    return replace(value, 0, start, "");
  }
  if (inputType.startsWith("delete") && inputType.endsWith("Forward")) {
    return replace(value, start, length, "");
  }
  return null;
}

function replace(value: string, start: number, end: number, text: string): EditResult {
  const current = characters(value);
  const from = Math.max(start, 0);
  const inserted = characters(text.replace(/[\r\n]/gu, ""));
  const next = [...current.slice(0, from), ...inserted, ...current.slice(end)];
  return { caret: from + inserted.length, value: next.join("") };
}

function filled(value: string, shown: string, caret: number): EditResult | null {
  const visible = characters(shown);
  const count = characters(value).length;
  if (visible.length === count && visible.every((character) => character === MASK)) return null;
  const firstNew = visible.slice(0, caret).findIndex((character) => character !== MASK);
  const start = firstNew === -1 ? caret : firstNew;
  const kept = Math.min(visible.length - caret, count - start);
  return replace(value, start, count - kept, visible.slice(start, caret).join(""));
}

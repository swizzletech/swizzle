// Text editing for a masked secret field, as a pure function: the field shows one mask character
// per character of the value, so every position here counts Unicode characters, never UTF-16 units.
// components/secret-input.tsx turns the browser's events into a SecretEdit and writes the result.

/** The field's caret or selection, in characters. */
export interface Selection {
  readonly end: number;
  readonly start: number;
}

/**
 * What changed the field:
 * - `typed`: a cancelled `beforeinput` of `inputType`, applied to the selection before it;
 * - `composed`: an IME composition that ended with `text`, over the selection where it started;
 * - `filled`: a change the field could not cancel, such as autofill, which left `shown` in the
 *   field; the selection is the caret after it.
 */
export type SecretEdit =
  | { readonly kind: "typed"; readonly inputType: string; readonly text: string }
  | { readonly kind: "composed"; readonly text: string }
  | { readonly kind: "filled"; readonly shown: string };

export interface EditResult {
  readonly caret: number;
  readonly value: string;
}

export const MASK = "•";

/** A value as Unicode characters; the field shows one mask character for each. */
export function characters(text: string): string[] {
  return Array.from(text);
}

/** The value after the edit and where the caret goes; null when the edit changes nothing. */
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
  // Masked text has no words or lines, so these delete to the start or end, as in a password field.
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

// The edit is already in the field. The text before the caret after the leading mask is what it
// inserted, and the mask after the caret is the unchanged end.
function filled(value: string, shown: string, caret: number): EditResult | null {
  const visible = characters(shown);
  const count = characters(value).length;
  if (visible.length === count && visible.every((character) => character === MASK)) return null;
  const firstNew = visible.slice(0, caret).findIndex((character) => character !== MASK);
  const start = firstNew === -1 ? caret : firstNew;
  const kept = Math.min(visible.length - caret, count - start);
  return replace(value, start, count - kept, visible.slice(start, caret).join(""));
}

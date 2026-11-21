import {
  type ComponentProps,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import { applyEdit, characters, MASK, type SecretEdit, type Selection } from "../lib/secret-edit";
import "./secret-input.css";

const PASSING = new Set(["insertCompositionText", "insertLineBreak", "insertParagraph"]);

export function SecretInput({
  className,
  onValueChange,
  ref,
  value,
  ...props
}: Omit<ComponentProps<"input">, "defaultValue" | "onChange" | "type" | "value"> & {
  readonly onValueChange: (value: string) => void;
  readonly value: string;
}) {
  const field = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => field.current as HTMLInputElement);
  const latest = useRef({ onValueChange, value });
  latest.current = { onValueChange, value };
  const composing = useRef<Selection | null>(null);

  useEffect(() => {
    const input = field.current;
    if (input === null) return;
    const apply = (selection: Selection, edit: SecretEdit) => {
      const result = applyEdit(latest.current.value, selection, edit);
      if (result === null) return;
      input.value = MASK.repeat(characters(result.value).length);
      input.setSelectionRange(result.caret, result.caret);
      latest.current.onValueChange(result.value);
    };
    const selection = (): Selection => {
      const start = input.selectionStart ?? 0;
      return { end: input.selectionEnd ?? start, start };
    };
    const onBeforeInput = (event: InputEvent) => {
      if (!event.cancelable || PASSING.has(event.inputType)) return;
      event.preventDefault();
      const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
      apply(selection(), { inputType: event.inputType, kind: "typed", text });
    };
    const onInput = () => {
      if (composing.current !== null) return;
      const caret = characters(
        input.value.slice(0, input.selectionEnd ?? input.value.length),
      ).length;
      apply({ end: caret, start: caret }, { kind: "filled", shown: input.value });
    };
    const onCompositionStart = () => {
      composing.current = selection();
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      const range = composing.current;
      composing.current = null;
      if (range !== null) apply(range, { kind: "composed", text: event.data });
    };
    input.addEventListener("beforeinput", onBeforeInput);
    input.addEventListener("input", onInput);
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    return () => {
      input.removeEventListener("beforeinput", onBeforeInput);
      input.removeEventListener("input", onInput);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  useLayoutEffect(() => {
    const input = field.current;
    const count = characters(value).length;
    if (input !== null && composing.current === null && input.value.length !== count) {
      input.value = MASK.repeat(count);
    }
  }, [value]);

  return (
    <input
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      data-1p-ignore="true"
      data-bwignore="true"
      data-form-type="other"
      data-lpignore="true"
      spellCheck={false}
      {...props}
      className={`field secret-value ${className ?? ""}`.trim()}
      defaultValue={MASK.repeat(characters(value).length)}
      ref={field}
      type="text"
    />
  );
}

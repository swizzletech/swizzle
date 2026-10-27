import { describe, expect, it } from "vitest";
import { applyEdit, MASK } from "./secret-edit";

const caret = (at: number) => ({ end: at, start: at });
const typed = (inputType: string, text = "") => ({ inputType, kind: "typed", text }) as const;

describe("applyEdit", () => {
  it("inserts typed and pasted text at the caret and over a selection", () => {
    expect(applyEdit("ac", caret(1), typed("insertText", "b"))).toEqual({ caret: 2, value: "abc" });
    expect(applyEdit("abcd", { end: 3, start: 1 }, typed("insertFromPaste", "XY"))).toEqual({
      caret: 3,
      value: "aXYd",
    });
  });

  it("drops line breaks from pasted text, since the value is one line", () => {
    expect(applyEdit("", caret(0), typed("insertFromPaste", "to\r\nken\n"))).toEqual({
      caret: 5,
      value: "token",
    });
  });

  it("counts characters, so an emoji or a surrogate pair stays whole", () => {
    expect(applyEdit("a😀b", caret(2), typed("deleteContentBackward"))).toEqual({
      caret: 1,
      value: "ab",
    });
    expect(applyEdit("ab", caret(1), typed("insertText", "𝄞"))).toEqual({
      caret: 2,
      value: "a𝄞b",
    });
  });

  it("deletes one character back or forward, and a selection either way", () => {
    expect(applyEdit("abc", caret(2), typed("deleteContentBackward"))).toEqual({
      caret: 1,
      value: "ac",
    });
    expect(applyEdit("abc", caret(0), typed("deleteContentBackward"))).toEqual({
      caret: 0,
      value: "abc",
    });
    expect(applyEdit("abc", caret(1), typed("deleteContentForward"))).toEqual({
      caret: 1,
      value: "ac",
    });
    expect(applyEdit("abcd", { end: 3, start: 1 }, typed("deleteByCut"))).toEqual({
      caret: 1,
      value: "ad",
    });
  });

  it("deletes a word or line to the start or end, as masked text has neither", () => {
    expect(applyEdit("abcd", caret(3), typed("deleteWordBackward"))).toEqual({
      caret: 0,
      value: "d",
    });
    expect(applyEdit("abcd", caret(1), typed("deleteSoftLineForward"))).toEqual({
      caret: 1,
      value: "a",
    });
  });

  it("changes nothing for an edit it does not know, such as undo", () => {
    expect(applyEdit("abc", caret(1), typed("historyUndo"))).toBeNull();
  });

  it("applies a finished composition over the selection it started on", () => {
    expect(applyEdit("ad", { end: 1, start: 1 }, { kind: "composed", text: "日本" })).toEqual({
      caret: 3,
      value: "a日本d",
    });
  });

  it("reads back what autofill put into the field between the mask", () => {
    const shown = `${MASK}XY${MASK}`;
    expect(applyEdit("ab", caret(3), { kind: "filled", shown })).toEqual({
      caret: 3,
      value: "aXYb",
    });
  });

  it("takes autofill over an empty field as the whole value", () => {
    expect(applyEdit("", caret(6), { kind: "filled", shown: "s3cret" })).toEqual({
      caret: 6,
      value: "s3cret",
    });
  });

  it("ignores an input event that left only the mask", () => {
    expect(applyEdit("ab", caret(1), { kind: "filled", shown: MASK.repeat(2) })).toBeNull();
  });
});

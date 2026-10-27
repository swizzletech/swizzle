import { describe, expect, it } from "vitest";
import { createOutputRedactor, createRunOutputRedactor } from "./output-redaction.js";

describe("output redaction", () => {
  // "abc" begins "abcdef", and "cdefg" overlaps both. A link token is caught by its shape; one
  // signature character short, it is no token.
  const redactor = createRunOutputRedactor(["abc", "abcdef", "cdefg"]);
  const link = `0b1e7c2a-5f3d-4c6b-9a8e-1d2f3a4b5c6d.Z2F0ZQ.${"s".repeat(43)}`;
  const output = `1 abcdef 2 abc 3 abcde 4 abcdefg 5 abcabc 6 /approvals/${link} 7 ${link.slice(0, -1)}\n`;
  const redacted = `1 [REDACTED] 2 [REDACTED] 3 [REDACTED]de 4 [REDACTED] 5 [REDACTED][REDACTED] 6 /approvals/[REDACTED] 7 ${link.slice(0, -1)}\n`;

  it("keeps wait links intact in worker reports while hiding exact secrets", () => {
    expect(createOutputRedactor(["secret"]).text(`secret /events/${link}`)).toBe(
      `[REDACTED] /events/${link}`,
    );
  });

  it("hides every character of every value", () => {
    expect(redactor.text(output)).toBe(redacted);
  });

  it("streams the same text wherever the chunks split", () => {
    for (let first = 0; first <= output.length; first++) {
      for (let second = first; second <= output.length; second++) {
        const stream = redactor.stream();
        const streamed = [
          stream.push(output.slice(0, first)),
          stream.push(output.slice(first, second)),
          stream.push(output.slice(second)),
          stream.end(),
        ].join("");
        expect(streamed, `split at ${first} and ${second}`).toBe(redacted);
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import { credentialSourceInWords } from "./credentials";

describe("credentialSourceInWords", () => {
  it("says a manage grant acts as use for someone who may not edit the environment", () => {
    const grant = { kind: "grant", right: "manage" } as const;
    expect(credentialSourceInWords(grant, "manage")).toBe("manage granted directly");
    expect(credentialSourceInWords(grant, "use")).toBe(
      "manage granted directly, which acts as use while they may not edit this environment",
    );
    expect(
      credentialSourceInWords(
        { kind: "team", right: "use", teamId: "t1", teamName: "Billing" },
        "use",
      ),
    ).toBe("use through the team Billing");
    expect(credentialSourceInWords({ kind: "role", role: "project-admin" }, "manage")).toBe(
      "as admin of its project",
    );
  });
});

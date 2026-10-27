import { describe, expect, it } from "vitest";

import { type ChainSource, chainSourcesInScope } from "./dashboard-shared.js";

const source = (slug: string): ChainSource => ({
  automationId: `id-${slug}`,
  name: slug,
  projectId: "office",
  slug,
});
const everything = { all: true } as const;

describe("chainSourcesInScope", () => {
  it("returns the scalar single source when there is no join table entry", () => {
    expect(chainSourcesInScope(source("exec-build"), [], everything)).toEqual({
      hidden: 0,
      names: ["exec-build"],
      slugs: ["exec-build"],
    });
  });

  it("returns every join source in order, over a stale scalar value", () => {
    const joined = ["review-standards", "review-spec", "e2e"].map((slug) => source(slug));

    expect(chainSourcesInScope(source("exec-build"), joined, everything).slugs).toEqual([
      "review-standards",
      "review-spec",
      "e2e",
    ]);
  });

  it("counts a same-project source outside an automation-only grant without naming it", () => {
    const office = {
      all: false,
      automations: [{ automationId: "id-intake", projectId: "office" }],
      projectIds: [],
    } as const;

    expect(chainSourcesInScope(null, [source("intake"), source("ledger")], office)).toEqual({
      hidden: 1,
      names: ["intake"],
      slugs: ["intake"],
    });
    expect(chainSourcesInScope(source("ledger"), [], office)).toEqual({
      hidden: 1,
      names: [],
      slugs: [],
    });
  });
});

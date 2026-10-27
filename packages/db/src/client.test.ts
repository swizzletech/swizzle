import { expect, it } from "vitest";
import { causeCode, causeViolation, PG_ERROR } from "./client.js";

it("reads the code and constraint from the same wrapped PostgreSQL error", () => {
  const postgres = Object.assign(new Error("duplicate key"), {
    code: PG_ERROR.uniqueViolation,
    constraint: "automation_triggers_webhook_path_unique",
  });
  const wrapped = new Error("query failed", {
    cause: new Error("transaction failed", { cause: postgres }),
  });
  expect(causeViolation(wrapped)).toEqual({
    code: PG_ERROR.uniqueViolation,
    constraint: "automation_triggers_webhook_path_unique",
  });
  expect(causeCode(wrapped)).toBe(PG_ERROR.uniqueViolation);
  expect(causeViolation({ cause: { code: PG_ERROR.foreignKeyViolation } })).toEqual({
    code: PG_ERROR.foreignKeyViolation,
    constraint: undefined,
  });
  expect(causeViolation(new Error("connection lost"))).toBeUndefined();
});

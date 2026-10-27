// Listener leaks and queued queries on one PostgreSQL connection must fail the gate.
import { setImmediate } from "node:timers/promises";
import { afterAll, expect } from "vitest";

const warnings: string[] = [];
const record = (warning: Error) => {
  if (
    warning.name === "MaxListenersExceededWarning" ||
    (warning.name === "DeprecationWarning" && warning.message.includes("client.query()"))
  )
    warnings.push(`${warning.name}: ${warning.message}`);
};
process.on("warning", record);
afterAll(async () => {
  // Node emits warnings on the next tick.
  await setImmediate();
  process.off("warning", record);
  expect(warnings).toEqual([]);
});

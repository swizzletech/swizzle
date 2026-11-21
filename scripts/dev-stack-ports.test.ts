import { expect, test } from "vitest";
import { choosePorts } from "./dev-stack-ports.ts";

test("chooses distinct ports when two services recorded the same port", async () => {
  const [recorded] = await choosePorts([undefined]);
  if (recorded === undefined) throw new Error("Expected an OS-assigned port");

  const ports = await choosePorts([recorded, recorded]);

  expect(new Set(ports).size).toBe(2);
});

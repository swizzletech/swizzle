import { expect, it } from "vitest";
import { createWakeGate, WAKE_SETTLE_MS } from "./wake-gate.js";

const at = (ms: number) => new Date(Date.UTC(2026, 9, 25, 12, 0, 0) + ms).toUTCString();

it("closes when the server clock jumps past the worker's and reopens after the settle window", () => {
  let now = 0;
  const gate = createWakeGate(() => now);
  gate.observe(at(0));
  now = 15_000;
  gate.observe(at(15_000));
  expect(gate.settled()).toBe(true);
  // The host slept for three minutes; the VM's monotonic clock stood still.
  now = 16_000;
  gate.observe(at(196_000));
  expect(gate.settled()).toBe(false);
  now += WAKE_SETTLE_MS - 1;
  gate.observe(at(196_000 + WAKE_SETTLE_MS - 1));
  expect(gate.settled()).toBe(false);
  now += 1;
  expect(gate.settled()).toBe(true);
});

it("restarts the settle window at each further pause", () => {
  let now = 0;
  const gate = createWakeGate(() => now);
  gate.observe(at(0));
  now = 1_000;
  gate.observe(at(181_000));
  // A 45-second DarkWake, then sleep again: the monotonic clock resumes where it stopped.
  now = 46_000;
  gate.observe(at(226_000));
  now = 47_000;
  gate.observe(at(527_000));
  now = 1_000 + WAKE_SETTLE_MS;
  expect(gate.settled()).toBe(false);
});

it("stays open when a reply delayed in transit arrives after a newer one", () => {
  let now = 10_000;
  const gate = createWakeGate(() => now);
  gate.observe(at(10_000));
  // A reply the server dated at 5 s spent five seconds in transit.
  now = 10_200;
  gate.observe(at(5_000));
  now = 11_000;
  gate.observe(at(11_000));
  expect(gate.settled()).toBe(true);
});

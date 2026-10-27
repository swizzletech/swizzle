import { describe, expect, it } from "vitest";

import { resolveServiceInstanceId } from "./instance-id.js";

// The instance id is half the heartbeat row key, so it must stay stable per container.
describe("resolveServiceInstanceId", () => {
  it("uses the trimmed SWIZZLE_INSTANCE_ID override", () => {
    expect(
      resolveServiceInstanceId({
        env: { SWIZZLE_INSTANCE_ID: "  worker-a  " },
        service: "worker",
      }),
    ).toBe("worker-a");
  });

  it("falls back to service and hostname when the override is blank", () => {
    expect(
      resolveServiceInstanceId({
        env: { SWIZZLE_INSTANCE_ID: " " },
        hostname: "my-host",
        service: "scheduler",
      }),
    ).toBe("scheduler-my-host");
  });
});

import { describe, expect, it } from "vitest";

import { resolveServiceInstanceId } from "./instance-id.js";

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

import { beforeEach, describe, expect, it, vi } from "vitest";

const isDockerAvailable = vi.fn();

vi.mock("@swizzle/runtime", () => ({ isDockerAvailable }));

const { assertWorkerSecurityConfiguration, WorkerSecurityConfigurationError } = await import(
  "./security-config.js"
);

describe("worker security configuration", () => {
  beforeEach(() => {
    isDockerAvailable.mockReset();
  });

  it("requires the sandbox and outbound proxy in production", async () => {
    await expect(assertWorkerSecurityConfiguration({ NODE_ENV: "production" })).rejects.toThrow(
      WorkerSecurityConfigurationError,
    );

    await expect(
      assertWorkerSecurityConfiguration({
        SWIZZLE_REQUIRE_SANDBOX: "true",
        NODE_ENV: "production",
      }),
    ).rejects.toThrow(/CONTROL_EGRESS_PROXY/u);
  });

  it("fails closed when Docker is unavailable", async () => {
    isDockerAvailable.mockResolvedValue(false);
    await expect(
      assertWorkerSecurityConfiguration({
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://proxy:3128",
        SWIZZLE_REQUIRE_SANDBOX: "true",
        NODE_ENV: "production",
      }),
    ).rejects.toThrow(/cannot reach/u);
  });

  it("accepts the packaged production boundary", async () => {
    isDockerAvailable.mockResolvedValue(true);
    await expect(
      assertWorkerSecurityConfiguration({
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://proxy:3128",
        SWIZZLE_REQUIRE_SANDBOX: "true",
        NODE_ENV: "production",
      }),
    ).resolves.toBeUndefined();
  });
});

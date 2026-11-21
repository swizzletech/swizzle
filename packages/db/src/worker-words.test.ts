import { describe, expect, it } from "vitest";
import { runImageDiskWarning } from "./worker-words.js";

describe("runImageDiskWarning", () => {
  it("names the worker, the total, the budget and the fix", () => {
    const warning = runImageDiskWarning("gpu-home", {
      activeBytes: 3.25 * 1024 * 1_048_576,
      unmeasured: { images: [], total: 0 },
      budgetBytes: 1024 * 1_048_576,
    });
    expect(warning && `${warning.title} ${warning.todo}`).toBe(
      "gpu-home keeps 3.3 GiB of run images for active deployments, more than its disk budget of 1.0 GiB. Swizzle keeps them so those deployments keep running. Remove deployments this worker runs, or raise SWIZZLE_RUNNER_IMAGE_DISK_MB on it and restart it.",
    );
  });

  it("reports the measured overage and the unmeasured active image together", () => {
    const image = `sha256:${"f".repeat(64)}`;
    const warning = runImageDiskWarning("gpu-home", {
      activeBytes: 50 * 1_048_576,
      budgetBytes: 10 * 1_048_576,
      unmeasured: { images: [{ id: image, tag: null }], total: 1 },
    });
    expect(warning?.title).toContain(image);
    expect(warning?.title).toContain("50 MiB");
    expect(warning?.title).toContain("10 MiB");
    expect(warning?.todo).toContain("Docker image history");
    expect(warning?.todo).toContain("SWIZZLE_RUNNER_IMAGE_DISK_MB");
  });
});

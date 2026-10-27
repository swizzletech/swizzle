import { describe, expect, it } from "vitest";
import { runImageDiskWarning } from "./worker-words.js";

describe("runImageDiskWarning", () => {
  it("names the worker, the total, the budget and the fix", () => {
    const { title, todo } = runImageDiskWarning("gpu-home", {
      activeBytes: 3.25 * 1024 * 1_048_576,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 1024 * 1_048_576,
    });
    expect(`${title} ${todo}`).toBe(
      "gpu-home keeps 3.3 GiB of run images for active deployments, more than its disk budget of 1.0 GiB. Swizzle keeps them so those deployments keep running. Remove deployments this worker runs, or raise SWIZZLE_RUNNER_IMAGE_DISK_MB on it and restart it.",
    );
  });
});

import {
  AUTOMATION_RUNTIME_EXECUTION_MODES,
  AUTOMATION_RUNTIME_LANGUAGES,
  WORKER_SERVICES,
} from "@swizzle/config";
import { RUN_IMAGE_DISK_DETAILS_LIMIT } from "@swizzle/db";
import { expect, it } from "vitest";
import { WORKER_ROUTES } from "./worker-wire.js";

// A heartbeat the schema accepts but the body limit refuses keeps a worker from ever pulling work.
it("takes a heartbeat at every bound of its schema within the route's body limit", () => {
  // A control character escapes to six bytes in JSON, the most any character takes.
  const field = "\u0001".repeat(80);
  const image = { id: `sha256:${"f".repeat(64)}`, tags: [`swizzle-run:${"f".repeat(24)}`] };
  const heartbeat = {
    capabilities: {
      languages: Array.from({ length: 8 }, (_, index) => ({
        name: AUTOMATION_RUNTIME_LANGUAGES[index % AUTOMATION_RUNTIME_LANGUAGES.length],
        version: field,
      })),
      binaries: Array.from({ length: 256 }, () => ({ name: field, version: field })),
      executionModes: Array.from(
        { length: 8 },
        (_, index) =>
          AUTOMATION_RUNTIME_EXECUTION_MODES[index % AUTOMATION_RUNTIME_EXECUTION_MODES.length],
      ),
      dependencyPackaging: { node: true, python: true },
    },
    services: Object.fromEntries(WORKER_SERVICES.map((service) => [service, "unhealthy"])),
    runImageDisk: {
      activeBytes: Number.MAX_SAFE_INTEGER,
      unmeasuredActiveImages: Array.from({ length: RUN_IMAGE_DISK_DETAILS_LIMIT }, () => ({
        ...image,
      })),
      unmeasuredActiveImagesOmitted: Number.MAX_SAFE_INTEGER,
      budgetBytes: Number.MAX_SAFE_INTEGER,
    },
  };

  expect(WORKER_ROUTES.runtime.request.safeParse(heartbeat).success).toBe(true);
  const extraImage = {
    ...heartbeat,
    runImageDisk: {
      ...heartbeat.runImageDisk,
      unmeasuredActiveImages: [...heartbeat.runImageDisk.unmeasuredActiveImages, image],
    },
  };
  expect(WORKER_ROUTES.runtime.request.safeParse(extraImage).success).toBe(false);
  const extraTag = structuredClone(heartbeat);
  extraTag.runImageDisk.unmeasuredActiveImages[0]?.tags.push(`swizzle-run:${"a".repeat(24)}`);
  expect(WORKER_ROUTES.runtime.request.safeParse(extraTag).success).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(heartbeat))).toBeLessThanOrEqual(
    WORKER_ROUTES.runtime.bodyLimit ?? 0,
  );
});

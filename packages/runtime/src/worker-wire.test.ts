import {
  AUTOMATION_RUNTIME_EXECUTION_MODES,
  AUTOMATION_RUNTIME_LANGUAGES,
  WORKER_SERVICES,
} from "@swizzle/config";
import { RUN_IMAGE_DISK_DETAILS_LIMIT } from "@swizzle/db";
import { expect, it } from "vitest";
import { WORKER_ROUTES } from "./worker-wire.js";

it("takes a heartbeat at every bound of its schema within the route's body limit", () => {
  const field = "\u0001".repeat(80);
  const image = { id: `sha256:${"f".repeat(64)}`, tag: `swizzle-run:${"f".repeat(24)}` };
  const heartbeat = {
    capabilities: {
      languages: Array.from({ length: 8 }, (_, index) => ({
        name: AUTOMATION_RUNTIME_LANGUAGES[index % AUTOMATION_RUNTIME_LANGUAGES.length],
        version: field,
      })),
      binaries: Array.from({ length: 2048 }, () => ({ name: field, version: field })),
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
      unmeasured: {
        images: Array.from({ length: RUN_IMAGE_DISK_DETAILS_LIMIT }, () => image),
        total: Number.MAX_SAFE_INTEGER,
      },
      budgetBytes: Number.MAX_SAFE_INTEGER,
    },
  };

  expect(WORKER_ROUTES.runtime.request.safeParse(heartbeat).success).toBe(true);
  const extraImage = {
    ...heartbeat,
    runImageDisk: {
      ...heartbeat.runImageDisk,
      unmeasured: {
        ...heartbeat.runImageDisk.unmeasured,
        images: [...heartbeat.runImageDisk.unmeasured.images, image],
      },
    },
  };
  expect(WORKER_ROUTES.runtime.request.safeParse(extraImage).success).toBe(false);
  const extraBinary = structuredClone(heartbeat);
  extraBinary.capabilities.binaries.push({ name: field, version: field });
  expect(WORKER_ROUTES.runtime.request.safeParse(extraBinary).success).toBe(false);
  const wrongTotal = structuredClone(heartbeat);
  wrongTotal.runImageDisk.unmeasured.total = 0;
  expect(WORKER_ROUTES.runtime.request.safeParse(wrongTotal).success).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(heartbeat))).toBeLessThanOrEqual(
    WORKER_ROUTES.runtime.bodyLimit ?? 0,
  );
});

it("accepts both released 1.x disk reports and normalizes the details", () => {
  const heartbeat = {
    capabilities: {
      languages: [],
      binaries: [],
      executionModes: [],
      dependencyPackaging: { node: false, python: false },
    },
    services: {},
  };
  const budget = { activeBytes: 50 * 1_048_576, budgetBytes: 10 * 1_048_576 };
  const firstId = `sha256:${"a".repeat(64)}`;
  const secondId = `sha256:${"b".repeat(64)}`;
  const tag = `swizzle-run:${"a".repeat(24)}`;
  expect(WORKER_ROUTES.runtime.request.parse({ ...heartbeat, runImageDisk: budget })).toEqual({
    ...heartbeat,
    runImageDisk: { ...budget, unmeasured: { images: [], total: 0 } },
  });
  const reported = {
    ...budget,
    unmeasuredActiveImages: [
      { id: firstId, tags: [tag] },
      { id: secondId, tags: [] },
    ],
    unmeasuredActiveImagesOmitted: 1,
  };
  expect(WORKER_ROUTES.runtime.request.parse({ ...heartbeat, runImageDisk: reported })).toEqual({
    ...heartbeat,
    runImageDisk: {
      ...budget,
      unmeasured: {
        images: [
          { id: firstId, tag },
          { id: secondId, tag: null },
        ],
        total: 3,
      },
    },
  });
  reported.unmeasuredActiveImages[0]?.tags.push(tag);
  expect(
    WORKER_ROUTES.runtime.request.safeParse({ ...heartbeat, runImageDisk: reported }).success,
  ).toBe(false);
});

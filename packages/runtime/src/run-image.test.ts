import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  RUN_IMAGE_DISK_DETAILS_LIMIT,
  runImageDiskOverBudget,
  runImageDiskWarning,
} from "@swizzle/db";
import { create as tarCreate } from "tar";
import { expect, it, vi } from "vitest";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import { PRUNE_DEADLINES, pruneRunImages } from "./run-image-prune.js";

const TEST_PRUNE_DEADLINES = { ...PRUNE_DEADLINES, transfer: 1_000 };

it("counts common ancestors of distinct custom bases once for disk warnings and pruning", async () => {
  const tags = ["swizzle-run:aaaaaaaaaaaaaaaaaaaaaaaa", "swizzle-run:bbbbbbbbbbbbbbbbbbbbbbbb"];
  // 200 MiB in common, 100/50 MiB custom base layers, and 1 MiB source per image.
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { common: 200, "base-a": 100, "source-a": 1 } },
    { tag: tags[1] ?? "", layers: { common: 200, "base-b": 50, "source-b": 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "400");
  expect(await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: {
      activeBytes: 369098752,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 419430400,
    },
  });
  expect(
    await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set([tags[0] ?? ""]) }),
  ).toEqual({
    removed: 0,
    disk: {
      activeBytes: 315621376,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 419430400,
    },
  });
});

it("counts a shared base once and retains images whose combined layers fit the budget", async () => {
  const tags = Array.from(
    { length: 11 },
    (_, index) => `swizzle-run:${index.toString(16).padStart(24, "0")}`,
  );
  await fakeDocker(
    tags.map((tag, index) => ({ tag, layers: { base: 300, [`source-${index}`]: 1 } })),
  );
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "320");
  expect(await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: {
      activeBytes: 326107136,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 335544320,
    },
  });
  expect(
    await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set([tags[0] ?? ""]) }),
  ).toEqual({
    removed: 0,
    disk: {
      activeBytes: 315621376,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 335544320,
    },
  });
});

it("counts an ancestor shared by three images once and prunes only the excess", async () => {
  const tags = Array.from({ length: 3 }, (_, i) => `swizzle-run:${String(i).repeat(24)}`);
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { common: 200, branch: 100, a: 1 } },
    { tag: tags[1] ?? "", layers: { common: 200, branch: 100, b: 1 } },
    { tag: tags[2] ?? "", layers: { common: 200, other: 50, c: 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "400");
  expect(await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: {
      activeBytes: 370147328,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 419430400,
    },
  });
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "320");
  expect(
    await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set([tags[0] ?? ""]) }),
  ).toEqual({
    removed: 1,
    disk: {
      activeBytes: 315621376,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 335544320,
    },
  });
});

it("retains a cached image when a fresh untagged commit shares its base", async () => {
  const active = `swizzle-run:${"a".repeat(24)}`;
  const cached = `swizzle-run:${"b".repeat(24)}`;
  await fakeDocker([
    { tag: active, layers: { base: 300, active: 1 } },
    { tag: cached, layers: { base: 300, cached: 1 } },
    { tag: null, fresh: true, layers: { base: 300, untagged: 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "320");
  expect(
    await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set([active]) }),
  ).toEqual({
    removed: 0,
    disk: {
      activeBytes: 315621376,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 335544320,
    },
  });
});

it("fails the pass when Docker cannot measure layer sizes", async () => {
  await fakeDocker(
    [
      { tag: `swizzle-run:${"a".repeat(24)}`, layers: { base: 300, a: 1 } },
      { tag: `swizzle-run:${"b".repeat(24)}`, layers: { base: 300, b: 1 } },
    ],
    false,
  );
  await expect(
    pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set() }),
  ).rejects.toThrow("history unavailable");
});

it.each(["unmappable", "missing-config"] as const)(
  "prunes over-budget images and names an image with %s history",
  async (fault) => {
    const active = `swizzle-run:${"a".repeat(24)}`;
    const cached = `swizzle-run:${"b".repeat(24)}`;
    const broken = `swizzle-run:${"c".repeat(24)}`;
    const { removed } = await fakeDocker([
      { tag: active, layers: { base: 300, empty: 0, active: 1 } },
      { tag: cached, layers: { base: 300, cached: 1 } },
      { tag: broken, layers: { base: 300, empty: 0, broken: 1 }, fault },
    ]);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "301");
    const warn = vi.fn();
    expect(
      await pruneRunImages({
        deadlines: TEST_PRUNE_DEADLINES,
        keep: new Set([active]),
        logger: { warn },
      }),
    ).toEqual({
      removed: 2,
      disk: {
        activeBytes: 315621376,
        unmeasuredActiveImagesOmitted: 0,
        unmeasuredActiveImages: [],
        budgetBytes: 315621376,
      },
    });
    expect((await readFile(removed, "utf8")).trim().split("\n")).toEqual([cached, broken]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: `sha256:${"2".padStart(64, "0")}`, tags: [broken] }),
      expect.stringContaining("Cannot measure run image"),
    );
  },
);

it.each(["timeout", "broken-archive"] as const)(
  "prunes inactive images and logs each unmeasured image after a %s export",
  async (exportFault) => {
    const active = `swizzle-run:${"a".repeat(24)}`;
    const inactive = `swizzle-run:${"b".repeat(24)}`;
    const { removed } = await fakeDocker(
      [
        { tag: active, layers: { base: 300, empty: 0, active: 1 } },
        { tag: inactive, layers: { base: 300, empty: 0, inactive: 1 } },
      ],
      true,
      exportFault,
    );
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "301");
    const warn = vi.fn();
    expect(
      await pruneRunImages({
        deadlines: TEST_PRUNE_DEADLINES,
        keep: new Set([active]),
        logger: { warn },
      }),
    ).toEqual({
      removed: 1,
      disk: {
        activeBytes: 0,
        unmeasuredActiveImagesOmitted: 0,
        unmeasuredActiveImages: [{ id: `sha256:${"0".repeat(64)}`, tags: [active] }],
        budgetBytes: 315621376,
      },
    });
    expect((await readFile(removed, "utf8")).trim()).toBe(inactive);
    expect(warn.mock.calls).toEqual([
      [
        { imageId: `sha256:${"0".repeat(64)}`, tags: [active] },
        "Cannot measure run image; disk usage is unknown.",
      ],
      [
        { imageId: `sha256:${"1".padStart(64, "0")}`, tags: [inactive] },
        "Cannot measure run image; disk usage is unknown.",
      ],
    ]);
  },
);

it("rejects caller cancellation during history export without removing images", async ({
  signal,
}) => {
  const { removed, saveStarted } = await fakeDocker(
    [{ tag: `swizzle-run:${"a".repeat(24)}`, layers: { base: 300, empty: 0, inactive: 1 } }],
    true,
    "timeout",
  );
  const controller = new AbortController();
  const pruning = pruneRunImages({
    deadlines: TEST_PRUNE_DEADLINES,
    keep: new Set(),
    signal: controller.signal,
  });
  const rejected = expect(pruning).rejects.toThrow("cancel image pruning");
  await waitFor(signal, () =>
    access(saveStarted).then(
      () => true,
      () => false,
    ),
  );
  controller.abort(new Error("cancel image pruning"));
  await rejected;
  await expect(readFile(removed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates ordinary Docker export failures", async () => {
  await fakeDocker(
    [{ tag: `swizzle-run:${"a".repeat(24)}`, layers: { base: 300, empty: 0, inactive: 1 } }],
    true,
    "runtime-failure",
  );
  await expect(
    pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set() }),
  ).rejects.toThrow("export unavailable");
});

it("rejects an expired prune owner during export without removing images", async ({ signal }) => {
  const { removed, saveStarted } = await fakeDocker(
    [{ tag: `swizzle-run:${"a".repeat(24)}`, layers: { base: 300, empty: 0, inactive: 1 } }],
    true,
    "timeout",
  );
  const pruning = pruneRunImages({
    keep: new Set(),
    deadlines: { ...TEST_PRUNE_DEADLINES, pass: 1_000, transfer: 5_000 },
  });
  const rejected = expect(pruning).rejects.toMatchObject({ code: "DOCKER_TRANSFER_TIMEOUT" });
  await waitFor(signal, () =>
    access(saveStarted).then(
      () => true,
      () => false,
    ),
  );
  await rejected;
  await expect(readFile(removed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["active", "fresh"] as const)(
  "keeps a protected %s image with unknown size and leaves no budget for cached images",
  async (protection) => {
    const protectedTag = `swizzle-run:${"a".repeat(24)}`;
    await fakeDocker([
      {
        tag: protectedTag,
        fresh: protection === "fresh",
        layers: { base: 300, empty: 0, protected: 1 },
        fault: "unmappable",
      },
      { tag: `swizzle-run:${"b".repeat(24)}`, layers: { base: 300, cached: 1 } },
    ]);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "400");
    expect(
      await pruneRunImages({
        deadlines: TEST_PRUNE_DEADLINES,
        keep: new Set(protection === "active" ? [protectedTag] : []),
      }),
    ).toEqual({
      removed: 1,
      disk: {
        activeBytes: 0,
        unmeasuredActiveImagesOmitted: 0,
        unmeasuredActiveImages:
          protection === "active" ? [{ id: `sha256:${"0".repeat(64)}`, tags: [protectedTag] }] : [],
        budgetBytes: 419430400,
      },
    });
  },
);

it("keeps a fresh unmeasured image and removes an inactive unmeasured image after grace", async () => {
  const fresh = `swizzle-run:${"a".repeat(24)}`;
  const inactive = `swizzle-run:${"b".repeat(24)}`;
  const { removed } = await fakeDocker([
    { tag: fresh, fresh: true, layers: { base: 300, empty: 0, fresh: 1 }, fault: "unmappable" },
    { tag: inactive, layers: { base: 300, empty: 0, inactive: 1 }, fault: "unmappable" },
  ]);
  expect((await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set() })).removed).toBe(
    1,
  );
  expect((await readFile(removed, "utf8")).trim()).toBe(inactive);
});

it("warns about an active unmeasured image without inventing bytes or recommending a larger budget", async () => {
  const tag = `swizzle-run:${"a".repeat(24)}`;
  await fakeDocker([{ tag, layers: { base: 300, empty: 0, active: 1 }, fault: "unmappable" }]);
  for (const budget of [400, 800]) {
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(budget));
    const { disk } = await pruneRunImages({
      deadlines: TEST_PRUNE_DEADLINES,
      keep: new Set([tag]),
    });
    expect(runImageDiskOverBudget({ state: "online", runImageDisk: disk })).toEqual(disk);
    expect(runImageDiskWarning("home", disk)).toEqual({
      title: `home keeps unmeasured run images for active deployments: sha256:${"0".repeat(64)} (${tag}). Their disk usage is unknown. Swizzle keeps them so those deployments keep running.`,
      todo: "Check this worker's Docker image history and prune logs, or remove the deployments that use these images.",
    });
  }
});

it("treats invalid layer sizes as unmeasured and still removes an inactive image", async () => {
  const active = `swizzle-run:${"a".repeat(24)}`;
  const inactive = `swizzle-run:${"b".repeat(24)}`;
  const { removed } = await fakeDocker([
    { tag: active, layers: { base: 300 }, fault: "invalid-sizes" },
    { tag: inactive, layers: { base: 300 }, fault: "invalid-sizes" },
  ]);
  const pass = await pruneRunImages({ keep: new Set([active]), deadlines: TEST_PRUNE_DEADLINES });
  expect(pass).toEqual({
    removed: 1,
    disk: {
      activeBytes: 0,
      budgetBytes: 21474836480,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [{ id: `sha256:${"0".repeat(64)}`, tags: [active] }],
    },
  });
  expect((await readFile(removed, "utf8")).trim()).toBe(inactive);
});

it("stops after configs without requiring the remaining layer archive", async () => {
  const active = `swizzle-run:${"a".repeat(24)}`;
  await fakeDocker(
    [{ tag: active, layers: { base: 300, empty: 0, active: 1 } }],
    true,
    "trailing-layer",
  );
  expect(
    await pruneRunImages({ keep: new Set([active]), deadlines: TEST_PRUNE_DEADLINES }),
  ).toEqual({
    removed: 0,
    disk: {
      activeBytes: 315621376,
      budgetBytes: 21474836480,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
    },
  });
});

it("bounds unknown image details without limiting retained images or hiding omitted usage", async () => {
  const tags = Array.from(
    { length: 20 },
    (_, index) => `swizzle-run:${index.toString(16).padStart(24, "0")}`,
  );
  await fakeDocker(tags.map((tag) => ({ tag, layers: { base: 1 }, fault: "invalid-sizes" })));
  const { removed, disk } = await pruneRunImages({
    keep: new Set(tags),
    deadlines: TEST_PRUNE_DEADLINES,
  });
  expect(removed).toBe(0);
  expect(disk.activeBytes).toBe(0);
  expect(disk.unmeasuredActiveImages).toEqual(
    tags.slice(0, RUN_IMAGE_DISK_DETAILS_LIMIT).map((tag, index) => ({
      id: `sha256:${index.toString(16).padStart(64, "0")}`,
      tags: [tag],
    })),
  );
  expect(disk.unmeasuredActiveImagesOmitted).toBe(12);
  expect(runImageDiskWarning("home", disk).title).toContain("12 more unmeasured active images");
  expect(runImageDiskOverBudget({ state: "online", runImageDisk: disk })).toEqual(disk);
});

it("counts zero-byte filesystem layers separately from metadata and still prunes", async () => {
  const tags = [`swizzle-run:${"a".repeat(24)}`, `swizzle-run:${"b".repeat(24)}`];
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { base: 300, empty: 0, a: 1 } },
    { tag: tags[1] ?? "", layers: { base: 300, empty: 0, b: 1 } },
    { tag: null, layers: { base: 300, empty: 0, orphan: 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "302");
  expect(await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set(tags) })).toEqual({
    removed: 1,
    disk: {
      activeBytes: 316669952,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 316669952,
    },
  });
});

it("counts the same diff under distinct parent chains separately", async () => {
  const tags = [`swizzle-run:${"a".repeat(24)}`, `swizzle-run:${"b".repeat(24)}`];
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { "base-a": 100, source: 1 } },
    { tag: tags[1] ?? "", layers: { "base-b": 50, source: 1 } },
  ]);
  expect(await pruneRunImages({ deadlines: TEST_PRUNE_DEADLINES, keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: {
      activeBytes: 159383552,
      unmeasuredActiveImagesOmitted: 0,
      unmeasuredActiveImages: [],
      budgetBytes: 21474836480,
    },
  });
});

/** Docker history includes metadata-only entries of zero bytes, in reverse layer order. */
async function fakeDocker(
  images: readonly {
    tag: string | null;
    fresh?: boolean;
    layers: Record<string, number>;
    fault?: "unmappable" | "missing-config" | "invalid-sizes";
  }[],
  historyAvailable = true,
  exportFault?: "timeout" | "broken-archive" | "runtime-failure" | "trailing-layer",
) {
  const directory = await temporaryDirectory("swizzle-image-layers-");
  const configs = await Promise.all(
    images.map(async (image, index) => {
      if (image.fault === "missing-config") return [];
      const file = `${index.toString(16).padStart(64, "0")}.json`;
      await writeFile(
        path.join(directory, file),
        JSON.stringify({
          rootfs: { diff_ids: Object.keys(image.layers) },
          history: [
            ...(image.fault === "unmappable" ? [{ empty_layer: true }] : []),
            ...Object.values(image.layers).flatMap(() => [
              { empty_layer: true },
              { empty_layer: false },
            ]),
            { empty_layer: true },
          ],
        }),
      );
      return [file];
    }),
  );
  const archive = path.join(directory, "images.tar");
  if (exportFault === "trailing-layer")
    await writeFile(path.join(directory, "payload"), Buffer.alloc(1_048_576));
  await tarCreate({ cwd: directory, file: archive }, [
    ...configs.flat(),
    ...(exportFault === "trailing-layer" ? ["payload"] : []),
  ]);

  const removed = path.join(directory, "removed");
  const saveStarted = path.join(directory, "save-started");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const images = ${JSON.stringify(images)}.map((image, i) => ({ ...image, id: 'sha256:' + i.toString(16).padStart(64, '0') }));
const created = new Date(Date.now() - 11 * 60_000).toISOString();
if (args[0] === 'ps') {}
else if (args[1] === 'ls') console.log(images.map(i => i.id).join('\\n'));
else if (args[1] === 'inspect') console.log(images.filter(i => args.slice(4).includes(i.id)).map(i => JSON.stringify([
  i.id, i.fresh ? new Date().toISOString() : created, i.tag === null ? [] : [i.tag], Object.keys(i.layers),
])).join('\\n'));
else if (args[1] === 'history') {
  if (!${historyAvailable}) { console.error('history unavailable'); process.exit(1); }
  const image = images.find(i => i.id === args.at(-1));
  if (image.fault === "invalid-sizes") { console.log("not-a-size"); return; }
  console.log([0, ...Object.values(image.layers).reverse().flatMap(size => [size * 1048576, 0])].join('\\n'));
}
else if (args[1] === 'save') {
  require('node:fs').writeFileSync(${JSON.stringify(saveStarted)}, 'started');
  if (${JSON.stringify(exportFault)} === 'runtime-failure') { console.error('export unavailable'); process.exit(1); }
  if (${JSON.stringify(exportFault)} === 'timeout') { setInterval(() => {}, 1000); return; }
  if (${JSON.stringify(exportFault)} === 'broken-archive') {
    process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(archive)}).subarray(0, 520));
    return;
  }
  process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(archive)}));
  if (!images.some(i => i.fault === 'missing-config')) setInterval(() => {}, 1000);
}
else if (args[1] === 'rm') { require('node:fs').appendFileSync(${JSON.stringify(removed)}, args.slice(2).join('\\n') + '\\n'); console.log(args.slice(2).join('\\n')); }
else { console.error('Unexpected Docker call: ' + args.join(' ')); process.exit(1); }
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("SWIZZLE_STACK", "layer-budget");
  return { removed, saveStarted };
}

// Closing preparation closes the process-wide Docker scopes, so give it fresh module state.
for (const fault of ["unmappable", "timeout", "broken-archive"] as const) {
  it(`logs an unmeasured image through worker preparation after ${fault} and completes pruning`, async ({
    signal,
  }) => {
    const active = `swizzle-run:${"a".repeat(24)}`;
    const broken = `swizzle-run:${"b".repeat(24)}`;
    const cached = `swizzle-run:${"c".repeat(24)}`;
    const { removed } = await fakeDocker(
      [
        { tag: active, layers: { base: 300, active: 1 } },
        { tag: broken, layers: { base: 300, empty: 0, broken: 1 }, fault: "unmappable" },
        { tag: cached, layers: { base: 300, cached: 1 } },
      ],
      true,
      fault === "unmappable" ? undefined : fault,
    );
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "301");
    vi.resetModules();
    const { startDeploymentPreparation } = await import("./deployment-preparation.js");
    const warn = vi.fn();
    const preparation = startDeploymentPreparation({
      poll: async () => ({ activeIds: [], deployments: [] }),
      recordImage: async () => {},
      keptImages: async () => [active],
      logger: { debug() {}, error() {}, info() {}, warn },
      pruneDeadlines: TEST_PRUNE_DEADLINES,
    });
    try {
      await waitFor(signal, () => preparation.runImageDisk() !== null);
      expect(preparation.runImageDisk()).toEqual({
        activeBytes: 315621376,
        unmeasuredActiveImagesOmitted: 0,
        unmeasuredActiveImages: [],
        budgetBytes: 315621376,
      });
      expect((await readFile(removed, "utf8")).trim().split("\n")).toEqual([broken, cached]);
      expect(warn).toHaveBeenCalledWith(
        { imageId: `sha256:${"1".padStart(64, "0")}`, tags: [broken] },
        "Cannot measure run image; disk usage is unknown.",
      );
    } finally {
      await preparation.close();
    }
  });
}

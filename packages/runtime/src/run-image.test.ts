import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runImageDiskOverBudget, runImageDiskWarning } from "@swizzle/db";
import { create as tarCreate } from "tar";
import { expect, it, vi } from "vitest";
import { heldDeadlines, temporaryDirectory, waitFor } from "../../../test/support.js";
import { PRUNE_DEADLINES, planPrune, pruneRunImages } from "./run-image-prune.js";

it("keeps the newest cache within budget, counting shared parent chains once", () => {
  expect(
    planPrune(
      {
        images: [
          {
            id: "other-base",
            createdAt: 200,
            tags: ["other-base"],
            footprint: {
              state: "measured",
              layers: [
                { id: "common", bytes: 200 },
                { id: "other", bytes: 50 },
                { id: "source-other", bytes: 1 },
              ],
            },
          },
          {
            id: "active",
            createdAt: 0,
            tags: ["active"],
            footprint: {
              state: "measured",
              layers: [
                { id: "common", bytes: 200 },
                { id: "base", bytes: 100 },
                { id: "source-active", bytes: 1 },
              ],
            },
          },
          {
            id: "newest",
            createdAt: 300,
            tags: ["newest"],
            footprint: {
              state: "measured",
              layers: [
                { id: "common", bytes: 200 },
                { id: "base", bytes: 100 },
                { id: "newest", bytes: 1 },
              ],
            },
          },
          {
            id: "active-other",
            createdAt: 0,
            tags: ["active-other"],
            footprint: {
              state: "measured",
              layers: [
                { id: "common", bytes: 200 },
                { id: "distinct", bytes: 10 },
                { id: "source-active-other", bytes: 1 },
              ],
            },
          },
        ],
        refused: new Set(),
      },
      new Set(["active", "active-other"]),
      1_000_000,
      313,
      2_000_000,
    ),
  ).toEqual({
    removals: [{ id: "other-base", references: ["other-base"] }],
    disk: {
      activeBytes: 312,
      budgetBytes: 313,
      unmeasured: { images: [], total: 0 },
    },
  });
});

it("counts the same layer diff under distinct parent chains separately", () => {
  expect(
    planPrune(
      {
        images: [
          {
            id: "image-a",
            createdAt: 0,
            tags: ["tag-a"],
            footprint: {
              state: "measured",
              layers: [
                { id: "base-a", bytes: 100 },
                { id: "shared-diff", bytes: 1 },
              ],
            },
          },
          {
            id: "image-b",
            createdAt: 0,
            tags: ["tag-b"],
            footprint: {
              state: "measured",
              layers: [
                { id: "base-b", bytes: 50 },
                { id: "shared-diff", bytes: 1 },
              ],
            },
          },
        ],
        refused: new Set(),
      },
      new Set(["tag-a", "tag-b"]),
      1_000_000,
      152,
      2_000_000,
    ),
  ).toEqual({
    removals: [],
    disk: {
      activeBytes: 152,
      budgetBytes: 152,
      unmeasured: { images: [], total: 0 },
    },
  });
});

it("counts the base shared by a fresh untagged image and a cached image once", () => {
  expect(
    planPrune(
      {
        images: [
          {
            id: "fresh",
            createdAt: 400_001,
            tags: [],
            footprint: {
              state: "measured",
              layers: [
                { id: "base", bytes: 10 },
                { id: "fresh-layer", bytes: 1 },
              ],
            },
          },
          {
            id: "cached",
            createdAt: 300_000,
            tags: ["cached"],
            footprint: {
              state: "measured",
              layers: [
                { id: "base", bytes: 10 },
                { id: "cached-layer", bytes: 1 },
              ],
            },
          },
        ],
        refused: new Set(),
      },
      new Set(),
      1_000_000,
      12,
      2_000_000,
    ),
  ).toEqual({
    removals: [],
    disk: {
      activeBytes: 0,
      budgetBytes: 12,
      unmeasured: { images: [], total: 0 },
    },
  });
});

it("keeps fresh untagged images even over budget and removes expired images newest first", () => {
  expect(
    planPrune(
      {
        images: [
          {
            id: "oldest",
            createdAt: 0,
            tags: ["swizzle-run:aaaaaaaaaaaaaaaaaaaaaaaa", "alias"],
            footprint: { state: "measured", layers: [] },
          },
          {
            id: "fresh",
            createdAt: 400_001,
            tags: [],
            footprint: { state: "measured", layers: [{ id: "large", bytes: 20 }] },
          },
          {
            id: "expired",
            createdAt: 300_000,
            tags: [],
            footprint: { state: "measured", layers: [] },
          },
          {
            id: "boundary",
            createdAt: 400_000,
            tags: ["boundary"],
            footprint: { state: "measured", layers: [{ id: "small", bytes: 1 }] },
          },
        ],
        refused: new Set(),
      },
      new Set(),
      1_000_000,
      10,
      700_000,
    ),
  ).toEqual({
    removals: [
      { id: "boundary", references: ["boundary"] },
      { id: "expired", references: ["expired"] },
      { id: "oldest", references: ["alias", "swizzle-run:aaaaaaaaaaaaaaaaaaaaaaaa"] },
    ],
    disk: {
      activeBytes: 0,
      budgetBytes: 10,
      unmeasured: { images: [], total: 0 },
    },
  });
});

it("removes expired cache even when the budget has room", () => {
  expect(
    planPrune(
      {
        images: [
          {
            id: "inside",
            createdAt: 300_001,
            tags: ["inside"],
            footprint: { state: "measured", layers: [{ id: "inside", bytes: 1 }] },
          },
          {
            id: "expired",
            createdAt: 300_000,
            tags: ["expired"],
            footprint: { state: "measured", layers: [{ id: "expired", bytes: 1 }] },
          },
        ],
        refused: new Set(),
      },
      new Set(),
      1_000_000,
      10,
      700_000,
    ),
  ).toEqual({
    removals: [{ id: "expired", references: ["expired"] }],
    disk: {
      activeBytes: 0,
      budgetBytes: 10,
      unmeasured: { images: [], total: 0 },
    },
  });
});

it.each([
  { tags: ["active", "alias"], createdAt: 100, details: [{ id: "protected", tag: "active" }] },
  { tags: [], createdAt: 400_001, details: [] },
])(
  "removes inactive cache when a protected image is unmeasured ($createdAt)",
  ({ tags, createdAt, details }) => {
    expect(
      planPrune(
        {
          images: [
            { id: "protected", createdAt, tags, footprint: { state: "unmeasured" } },
            {
              id: "measured-cache",
              createdAt: 300,
              tags: ["measured-cache"],
              footprint: { state: "measured", layers: [{ id: "base", bytes: 5 }] },
            },
            {
              id: "unmeasured-cache",
              createdAt: 200,
              tags: ["unmeasured-cache"],
              footprint: { state: "unmeasured" },
            },
          ],
          refused: new Set(),
        },
        new Set(["active"]),
        1_000_000,
        10,
        2_000_000,
      ),
    ).toEqual({
      removals: [
        { id: "measured-cache", references: ["measured-cache"] },
        { id: "unmeasured-cache", references: ["unmeasured-cache"] },
      ],
      disk: {
        activeBytes: 0,
        budgetBytes: 10,
        unmeasured: { images: details, total: details.length },
      },
    });
  },
);

it("replans after a refused removal and preserves the newer cache decisions", async () => {
  const oversized = `swizzle-run:${"d".repeat(24)}`;
  const newest = `swizzle-run:${"a".repeat(24)}`;
  const refused = `swizzle-run:${"b".repeat(24)}`;
  const oldest = `swizzle-run:${"c".repeat(24)}`;
  const { removed } = await fakeDocker([
    { tag: oversized, layers: { oversized: 5 } },
    { tag: newest, layers: { newest: 2 } },
    { tag: refused, layers: { refused: 3 }, fault: "refused-removal" },
    { tag: oldest, layers: { oldest: 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "4");
  expect(await pruneRunImages({ keep: new Set() })).toEqual({
    removed: 2,
    disk: {
      activeBytes: 0,
      budgetBytes: 4194304,
      unmeasured: { images: [], total: 0 },
    },
  });
  expect((await readFile(removed, "utf8")).trim().split("\n")).toEqual([
    oversized,
    refused,
    oldest,
  ]);
});

it("continues pruning other images after one image history exits nonzero", async () => {
  const active = `swizzle-run:${"a".repeat(24)}`;
  const inactive = `swizzle-run:${"b".repeat(24)}`;
  const { removed } = await fakeDocker([
    { tag: active, layers: { base: 300 }, fault: "history-unavailable" },
    { tag: inactive, layers: { base: 300, source: 1 } },
  ]);
  const warn = vi.fn();
  expect(await pruneRunImages({ keep: new Set([active]), logger: { warn } })).toEqual({
    removed: 1,
    disk: {
      activeBytes: 0,
      budgetBytes: 21474836480,
      unmeasured: { images: [{ id: `sha256:${"0".repeat(64)}`, tag: active }], total: 1 },
    },
  });
  expect((await readFile(removed, "utf8")).trim()).toBe(inactive);
  expect(warn.mock.calls).toEqual([
    [
      { imageId: `sha256:${"0".repeat(64)}`, tags: [active] },
      "Cannot measure run image; disk usage is unknown.",
    ],
  ]);
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
        keep: new Set([active]),
        logger: { warn },
      }),
    ).toEqual({
      removed: 2,
      disk: {
        activeBytes: 315621376,
        unmeasured: { images: [], total: 0 },
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

it.for(["timeout", "broken-archive"] as const)(
  "prunes inactive images and logs each unmeasured image after a %s export",
  async (exportFault, { signal }) => {
    const active = `swizzle-run:${"a".repeat(24)}`;
    const inactive = `swizzle-run:${"b".repeat(24)}`;
    const { removed, saveStarted } = await fakeDocker(
      [
        { tag: active, layers: { base: 300, empty: 0, active: 1 } },
        { tag: inactive, layers: { base: 300, empty: 0, inactive: 1 } },
      ],
      exportFault,
    );
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "301");
    const warn = vi.fn();
    const deadlines = heldDeadlines(PRUNE_DEADLINES.transfer);
    const pruning = pruneRunImages({ keep: new Set([active]), logger: { warn } });
    if (exportFault === "timeout") {
      await waitFor(signal, () =>
        access(saveStarted).then(
          () => true,
          () => false,
        ),
      );
      deadlines.expire();
    }
    expect(await pruning).toEqual({
      removed: 1,
      disk: {
        activeBytes: 0,
        unmeasured: { images: [{ id: `sha256:${"0".repeat(64)}`, tag: active }], total: 1 },
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
    "timeout",
  );
  const controller = new AbortController();
  const pruning = pruneRunImages({
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
    "runtime-failure",
  );
  await expect(pruneRunImages({ keep: new Set() })).rejects.toThrow("export unavailable");
});

it("rejects an expired prune owner during export without removing images", async ({ signal }) => {
  const { removed, saveStarted } = await fakeDocker(
    [{ tag: `swizzle-run:${"a".repeat(24)}`, layers: { base: 300, empty: 0, inactive: 1 } }],
    "timeout",
  );
  const deadline = heldDeadlines(PRUNE_DEADLINES.pass);
  const pruning = pruneRunImages({ keep: new Set() });
  const rejected = expect(pruning).rejects.toMatchObject({ code: "DOCKER_TRANSFER_TIMEOUT" });
  await waitFor(signal, () =>
    access(saveStarted).then(
      () => true,
      () => false,
    ),
  );
  deadline.expire();
  await rejected;
  await expect(readFile(removed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it.for(["abort", "pass deadline", "command deadline"] as const)(
  "handles %s during one image history",
  async (failure, { signal }) => {
    const tag = `swizzle-run:${"a".repeat(24)}`;
    const { removed, historyStarted } = await fakeDocker([
      { tag, layers: { base: 1 }, fault: "history-stalled" },
    ]);
    const deadlines = heldDeadlines();
    const controller = new AbortController();
    const pruning = pruneRunImages({ keep: new Set(), signal: controller.signal });
    const outcome =
      failure === "command deadline"
        ? expect(pruning).resolves.toMatchObject({ removed: 1 })
        : expect(pruning).rejects.toMatchObject({
            code: failure === "abort" ? "CONTAINER_RUNTIME_UNAVAILABLE" : "DOCKER_CONTROL_TIMEOUT",
          });
    await waitFor(signal, () =>
      access(historyStarted).then(
        () => true,
        () => false,
      ),
    );
    if (failure === "abort") controller.abort(new Error("cancel image pruning"));
    else if (failure === "pass deadline") deadlines.expire(0);
    else deadlines.expireNewest();
    await outcome;
    if (failure === "command deadline") expect((await readFile(removed, "utf8")).trim()).toBe(tag);
    else await expect(readFile(removed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("treats invalid layer sizes as unmeasured and still removes an inactive image", async () => {
  const active = `swizzle-run:${"a".repeat(24)}`;
  const inactive = `swizzle-run:${"b".repeat(24)}`;
  const { removed } = await fakeDocker([
    { tag: active, layers: { base: 300 }, fault: "invalid-sizes" },
    { tag: inactive, layers: { base: 300 }, fault: "invalid-sizes" },
  ]);
  const pass = await pruneRunImages({ keep: new Set([active]) });
  expect(pass).toEqual({
    removed: 1,
    disk: {
      activeBytes: 0,
      budgetBytes: 21474836480,
      unmeasured: { images: [{ id: `sha256:${"0".repeat(64)}`, tag: active }], total: 1 },
    },
  });
  expect((await readFile(removed, "utf8")).trim()).toBe(inactive);
});

it("stops after configs without requiring the remaining layer archive", async () => {
  const active = `swizzle-run:${"a".repeat(24)}`;
  await fakeDocker([{ tag: active, layers: { base: 300, empty: 0, active: 1 } }], "trailing-layer");
  expect(await pruneRunImages({ keep: new Set([active]) })).toEqual({
    removed: 0,
    disk: {
      activeBytes: 315621376,
      budgetBytes: 21474836480,
      unmeasured: { images: [], total: 0 },
    },
  });
});

it("bounds unmeasured active details without limiting retention", () => {
  const images = Array.from({ length: 9 }, (_, index) => ({
    id: `image-${index}`,
    createdAt: 0,
    tags: [`tag-${index}`],
    footprint: { state: "unmeasured" as const },
  }));
  const plan = planPrune(
    { images, refused: new Set() },
    new Set(["tag-0", "tag-1", "tag-2", "tag-3", "tag-4", "tag-5", "tag-6", "tag-7", "tag-8"]),
    1_000_000,
    10,
    2_000_000,
  );
  expect(plan).toEqual({
    removals: [],
    disk: {
      activeBytes: 0,
      budgetBytes: 10,
      unmeasured: {
        images: [
          { id: "image-0", tag: "tag-0" },
          { id: "image-1", tag: "tag-1" },
          { id: "image-2", tag: "tag-2" },
          { id: "image-3", tag: "tag-3" },
          { id: "image-4", tag: "tag-4" },
          { id: "image-5", tag: "tag-5" },
          { id: "image-6", tag: "tag-6" },
          { id: "image-7", tag: "tag-7" },
        ],
        total: 9,
      },
    },
  });
  expect(runImageDiskWarning("home", plan.disk)?.title).toContain("1 more unmeasured active image");
  expect(runImageDiskOverBudget({ state: "online", runImageDisk: plan.disk })).toEqual(plan.disk);
});

it("counts zero-byte filesystem layers separately from metadata and still prunes", async () => {
  const tags = [`swizzle-run:${"a".repeat(24)}`, `swizzle-run:${"b".repeat(24)}`];
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { base: 300, empty: 0, a: 1 } },
    { tag: tags[1] ?? "", layers: { base: 300, empty: 0, b: 1 } },
    { tag: null, layers: { base: 300, empty: 0, orphan: 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "302");
  expect(await pruneRunImages({ keep: new Set(tags) })).toEqual({
    removed: 1,
    disk: {
      activeBytes: 316669952,
      unmeasured: { images: [], total: 0 },
      budgetBytes: 316669952,
    },
  });
});

async function fakeDocker(
  images: readonly {
    tag: string | null;
    fresh?: boolean;
    layers: Record<string, number>;
    fault?:
      | "unmappable"
      | "missing-config"
      | "invalid-sizes"
      | "history-unavailable"
      | "history-stalled"
      | "refused-removal";
  }[],
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
  const historyStarted = path.join(directory, "history-started");
  const saveStarted = path.join(directory, "save-started");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const now = Date.now();
const images = ${JSON.stringify(images)}.map((image, i) => ({ ...image, id: 'sha256:' + i.toString(16).padStart(64, '0'), created: new Date(now - 11 * 60_000 - i).toISOString() }));
if (args[0] === 'ps') {}
else if (args[1] === 'ls') console.log(images.map(i => i.id).join('\\n'));
else if (args[1] === 'inspect') console.log(images.filter(i => args.slice(4).includes(i.id)).map(i => JSON.stringify([
  i.id, i.fresh ? new Date().toISOString() : i.created, i.tag === null ? [] : [i.tag], Object.keys(i.layers),
])).join('\\n'));
else if (args[1] === 'history') {
  const image = images.find(i => i.id === args.at(-1));
  if (image.fault === "history-unavailable") { console.error('history unavailable'); process.exit(1); }
  if (image.fault === "history-stalled") { require("node:fs").writeFileSync(${JSON.stringify(historyStarted)}, "started"); setInterval(() => {}, 1000); return; }
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
else if (args[1] === 'rm') {
  const references = args.slice(2);
  require('node:fs').appendFileSync(${JSON.stringify(removed)}, references.join('\\n') + '\\n');
  if (images.some(i => i.fault === "refused-removal" && references.includes(i.tag))) { console.error("image in use"); process.exit(1); }
  console.log(references.join('\\n'));
}
else { console.error('Unexpected Docker call: ' + args.join(' ')); process.exit(1); }
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("SWIZZLE_STACK", "layer-budget");
  return { removed, saveStarted, historyStarted };
}

for (const fault of ["unmappable", "timeout", "broken-archive"] as const) {
  it(`logs an unmeasured image through worker preparation after ${fault} and completes pruning`, async ({
    signal,
  }) => {
    const active = `swizzle-run:${"a".repeat(24)}`;
    const broken = `swizzle-run:${"b".repeat(24)}`;
    const cached = `swizzle-run:${"c".repeat(24)}`;
    const { removed, saveStarted } = await fakeDocker(
      [
        { tag: active, layers: { base: 300, active: 1 } },
        { tag: broken, layers: { base: 300, empty: 0, broken: 1 }, fault: "unmappable" },
        { tag: cached, layers: { base: 300, cached: 1 } },
      ],
      fault === "unmappable" ? undefined : fault,
    );
    const deadlines = heldDeadlines(PRUNE_DEADLINES.transfer);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "301");
    vi.resetModules();
    const { startDeploymentPreparation } = await import("./deployment-preparation.js");
    const warn = vi.fn();
    const preparation = startDeploymentPreparation({
      poll: async () => ({ activeIds: [], deployments: [] }),
      recordImage: async () => {},
      keptImages: async () => [active],
      logger: { debug() {}, error() {}, info() {}, warn },
    });
    try {
      if (fault === "timeout") {
        await waitFor(signal, () =>
          access(saveStarted).then(
            () => true,
            () => false,
          ),
        );
        deadlines.expire();
      }
      await waitFor(signal, () => preparation.runImageDisk() !== null);
      expect(preparation.runImageDisk()).toEqual({
        activeBytes: 315621376,
        unmeasured: { images: [], total: 0 },
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

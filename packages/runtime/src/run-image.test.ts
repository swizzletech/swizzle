import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { temporaryDirectory } from "../../../test/support.js";
import { pruneRunImages } from "./run-image.js";

it("counts common ancestors of distinct custom bases once for disk warnings and pruning", async () => {
  const tags = ["swizzle-run:aaaaaaaaaaaaaaaaaaaaaaaa", "swizzle-run:bbbbbbbbbbbbbbbbbbbbbbbb"];
  // 200 MiB in common, 100/50 MiB custom base layers, and 1 MiB source per image.
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { common: 200, "base-a": 100, "source-a": 1 } },
    { tag: tags[1] ?? "", layers: { common: 200, "base-b": 50, "source-b": 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "400");
  expect(await pruneRunImages({ keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: { activeBytes: 369098752, budgetBytes: 419430400 },
  });
  expect(await pruneRunImages({ keep: new Set([tags[0] ?? ""]) })).toEqual({
    removed: 0,
    disk: { activeBytes: 315621376, budgetBytes: 419430400 },
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
  expect(await pruneRunImages({ keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: { activeBytes: 326107136, budgetBytes: 335544320 },
  });
  expect(await pruneRunImages({ keep: new Set([tags[0] ?? ""]) })).toEqual({
    removed: 0,
    disk: { activeBytes: 315621376, budgetBytes: 335544320 },
  });
});

it("measures a large inventory on one base with one metadata request", async () => {
  const tags = Array.from(
    { length: 500 },
    (_, i) => `swizzle-run:${i.toString(16).padStart(24, "0")}`,
  );
  const requests = await fakeDocker(
    tags.map((tag, i) => ({ tag, layers: { base: 300, [`source-${i}`]: 1 } })),
  );
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "1000");
  expect(await pruneRunImages({ keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: { activeBytes: 838860800, budgetBytes: 1048576000 },
  });
  expect(await readFile(requests, "utf8")).toBe("usage\n");
});

it("counts an ancestor shared by three images once and prunes only the excess", async () => {
  const tags = Array.from({ length: 3 }, (_, i) => `swizzle-run:${String(i).repeat(24)}`);
  await fakeDocker([
    { tag: tags[0] ?? "", layers: { common: 200, branch: 100, a: 1 } },
    { tag: tags[1] ?? "", layers: { common: 200, branch: 100, b: 1 } },
    { tag: tags[2] ?? "", layers: { common: 200, other: 50, c: 1 } },
  ]);
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "400");
  expect(await pruneRunImages({ keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: { activeBytes: 370147328, budgetBytes: 419430400 },
  });
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "320");
  expect(await pruneRunImages({ keep: new Set([tags[0] ?? ""]) })).toEqual({
    removed: 1,
    disk: { activeBytes: 315621376, budgetBytes: 335544320 },
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
  expect(await pruneRunImages({ keep: new Set([active]) })).toEqual({
    removed: 0,
    disk: { activeBytes: 315621376, budgetBytes: 335544320 },
  });
});

it("reads chunked Docker metadata forwarded by the broker", async () => {
  const tags = [`swizzle-run:${"a".repeat(24)}`, `swizzle-run:${"b".repeat(24)}`];
  await fakeDocker(
    [
      { tag: tags[0] ?? "", layers: { common: 200, a: 1 } },
      { tag: tags[1] ?? "", layers: { common: 200, b: 1 } },
    ],
    200,
    true,
  );
  expect(await pruneRunImages({ keep: new Set(tags) })).toEqual({
    removed: 0,
    disk: { activeBytes: 211812352, budgetBytes: 21474836480 },
  });
});

it("fails the pass when Docker cannot measure shared disk use", async () => {
  await fakeDocker(
    [
      { tag: `swizzle-run:${"a".repeat(24)}`, layers: { base: 300, a: 1 } },
      { tag: `swizzle-run:${"b".repeat(24)}`, layers: { base: 300, b: 1 } },
    ],
    503,
  );
  await expect(pruneRunImages({ keep: new Set() })).rejects.toThrow(
    "Cannot measure shared disk use",
  );
});

/** Docker's boundary: usage shares only the images selected by reference. */
async function fakeDocker(
  images: readonly { tag: string | null; fresh?: boolean; layers: Record<string, number> }[],
  status = 200,
  chunked = false,
) {
  const directory = await temporaryDirectory("swizzle-image-layers-");
  const requests = path.join(directory, "requests.txt");
  await writeFile(
    path.join(directory, "docker"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const fs = require('node:fs');
const aliasFile = ${JSON.stringify(path.join(directory, "aliases.json"))};
const aliases = fs.existsSync(aliasFile) ? JSON.parse(fs.readFileSync(aliasFile, 'utf8')) : {};
const images = ${JSON.stringify(images)}.map((image, i) => ({
  ...image, id: 'image-' + i,
  bytes: Object.values(image.layers).reduce((a, b) => a + b, 0) * 1048576,
}));
const created = new Date(Date.now() - 11 * 60_000).toISOString();
if (args[0] === 'ps') {}
else if (args[1] === 'ls') console.log(images.map(i => i.id).join('\\n'));
else if (args[1] === 'inspect') console.log(images.filter(i => args.slice(4).includes(i.id)).map(i => JSON.stringify([
  i.id, i.fresh ? new Date().toISOString() : created, i.bytes, i.tag === null ? [] : [i.tag], Object.keys(i.layers),
])).join('\\n'));
else if (args[0] === 'tag') { aliases[args[2]] = args[1]; fs.writeFileSync(aliasFile, JSON.stringify(aliases)); }
else if (args[1] === 'rm') console.log(args.slice(2).join('\\n'));
else if (args[1] === 'dial-stdio') process.stdin.once('data', request => {
  fs.appendFileSync(${JSON.stringify(requests)}, 'usage\\n');
  const url = new URL(request.toString().split(' ')[1], 'http://docker');
  const refs = JSON.parse(url.searchParams.get('filters')).reference;
  const selected = images.filter(i => refs === undefined || refs.includes(i.tag) || refs.some(ref => aliases[ref] === i.id));
  const body = selected.map(i => ({ Id: i.id, Size: i.bytes, SharedSize:
    Object.entries(i.layers).reduce((sum, [id, size]) => sum +
      (selected.some(other => other.id !== i.id && id in other.layers) ? size * 1048576 : 0), 0),
  }));
  const json = JSON.stringify(body);
  const response = ${chunked} ? 'HTTP/1.1 ${status} Docker\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n' + Buffer.byteLength(json).toString(16) + '\\r\\n' + json + '\\r\\n0\\r\\n\\r\\n' : 'HTTP/1.0 ${status} Docker\\r\\n\\r\\n' + json;
  process.stdout.write(response, () => process.exit(0));
});
else { console.error('Unexpected Docker call: ' + args.join(' ')); process.exit(1); }
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.stubEnv("SWIZZLE_STACK", "layer-budget");
  return requests;
}

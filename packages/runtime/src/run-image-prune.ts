import { RUN_IMAGE_DISK_DETAILS_LIMIT, type RunImageDisk } from "@swizzle/db";
import {
  DOCKER_DEADLINES,
  DockerScope,
  removeAbandonedContainers,
  stackLabel,
} from "./docker-cli.js";
import { readImageLayerHistory } from "./docker-image-history.js";
import { AutomationRuntimeError } from "./errors.js";

export const PRUNE_PASS_TIMEOUT_MS = DOCKER_DEADLINES.transfer + 12 * DOCKER_DEADLINES.control;

const DEFAULT_IMAGE_RETENTION_HOURS = 24;
const DEFAULT_IMAGE_DISK_MB = 20_480;
export const RUN_IMAGE_PRUNE_INTERVAL_MS = 15 * 60 * 1_000;
const FRESH_IMAGE_MS = 10 * 60 * 1_000;
const RUN_TAG = /^swizzle-run:([0-9a-f]{24})$/u;
const IMAGE_FORMAT = `[{{json .Id}},{{json .Created}},{{json .RepoTags}},{{json .RootFS.Layers}}]`;

export async function pruneRunImages(input: {
  readonly keep: ReadonlySet<string>;
  readonly logger?: ImagePruneLogger;
  readonly signal?: AbortSignal;
}): Promise<{ readonly removed: number; readonly disk: RunImageDisk }> {
  return await withPassOwner(async (owner) => {
    const docker: DockerCall = (args) => owner.run(args, { outputLimitBytes: 1_048_576 });
    const now = Date.now();
    const budgetBytes = diskBudgetBytes();
    await removeAbandonedContainers();
    const listed = await listStackRunImages(docker);
    const inventory = await measureImageFootprints(listed, owner, input.logger);
    const remaining = new Map(inventory.map((image) => [image.id, image]));
    const imageCount = remaining.size;
    const refused = new Set<string>();
    const retentionMs =
      positiveInteger("SWIZZLE_RUNNER_IMAGE_RETENTION_HOURS", DEFAULT_IMAGE_RETENTION_HOURS) *
      3_600_000;
    for (;;) {
      const { removals, disk } = planPrune(
        { images: [...remaining.values()], refused },
        input.keep,
        now,
        budgetBytes,
        retentionMs,
      );
      const refusedId = await executeRemovals(removals, remaining, docker);
      if (refusedId === null) {
        input.signal?.throwIfAborted();
        return { removed: imageCount - remaining.size, disk };
      }
      refused.add(refusedId);
    }
  }, input.signal);
}

type ImageRemoval = { readonly id: string; readonly references: readonly string[] };

async function executeRemovals(
  removals: readonly ImageRemoval[],
  remaining: Map<string, RunImage>,
  docker: DockerCall,
): Promise<string | null> {
  for (const { id, references } of removals) {
    try {
      await docker(["image", "rm", ...references]);
    } catch (error) {
      if (error instanceof AutomationRuntimeError) throw error;
      return id;
    }
    remaining.delete(id);
  }
  return null;
}

export function planPrune(
  inventory: { readonly images: readonly RunImage[]; readonly refused: ReadonlySet<string> },
  keep: ReadonlySet<string>,
  now: number,
  budgetBytes: number,
  retentionMs: number,
): {
  readonly removals: readonly ImageRemoval[];
  readonly disk: RunImageDisk;
} {
  const active: RunImage[] = [];
  const reserved: RunImage[] = [];
  const candidates: RunImage[] = [];
  for (const image of inventory.images) {
    if (image.tags.some((tag) => keep.has(tag))) active.push(image);
    else if (now - image.createdAt < FRESH_IMAGE_MS || inventory.refused.has(image.id))
      reserved.push(image);
    else candidates.push(image);
  }

  const retained = new Set<string>();
  const activeBytes = countRetainedBytes(active, retained);
  const unmeasured = active.filter((image) => image.footprint.state === "unmeasured");
  const images = unmeasured
    .slice(0, RUN_IMAGE_DISK_DETAILS_LIMIT)
    .map(({ id, tags }) => ({ id, tag: tags.find((tag) => keep.has(tag)) ?? null }));
  let bytes = activeBytes + countRetainedBytes(reserved, retained);
  const hasUnmeasured =
    unmeasured.length > 0 || reserved.some((image) => image.footprint.state === "unmeasured");

  const removals: ImageRemoval[] = [];
  candidates.sort((left, right) => right.createdAt - left.createdAt);
  for (const { id, tags, createdAt, footprint } of candidates) {
    const additional =
      footprint.state === "measured" ? unretainedLayers(footprint.layers, retained) : null;
    if (
      additional !== null &&
      !hasUnmeasured &&
      now - createdAt < retentionMs &&
      bytes + additional.bytes <= budgetBytes
    ) {
      bytes += additional.bytes;
      for (const chain of additional.chains) retained.add(chain);
      continue;
    }
    removals.push({ id, references: tags.length === 0 ? [id] : [...tags].sort(runTagLast) });
  }
  return {
    removals,
    disk: { activeBytes, budgetBytes, unmeasured: { images, total: unmeasured.length } },
  };
}

type ImagePruneLogger = { warn(...args: readonly unknown[]): void };

type DockerCall = (args: readonly string[]) => Promise<{ readonly stdout: string }>;

async function withPassOwner<T>(
  pass: (docker: DockerScope) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const owner = new DockerScope({
    timeoutMs: PRUNE_PASS_TIMEOUT_MS,
    containerName: null,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    return await pass(owner);
  } finally {
    await owner.close();
  }
}

async function listStackRunImages(docker: DockerCall): Promise<InspectedRunImage[]> {
  const listed = await docker([
    "image",
    "ls",
    "--all",
    "--filter",
    `label=${stackLabel()}`,
    "--quiet",
    "--no-trunc",
  ]);
  const ids = [...new Set(listed.stdout.split("\n").map((id) => id.trim()))].filter(Boolean);
  if (ids.length === 0) return [];
  const batchSize = Math.max(16, Math.ceil(ids.length / 8));
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    batches.push(ids.slice(offset, offset + batchSize));
  }
  const inspected = await Promise.all(
    batches.map((batch) => docker(["image", "inspect", "--format", IMAGE_FORMAT, ...batch])),
  );
  return inspected.flatMap(({ stdout }) => stdout.split("\n").flatMap(parseRunImage));
}

async function measureImageFootprints(
  images: readonly InspectedRunImage[],
  owner: DockerScope,
  logger: ImagePruneLogger | undefined,
): Promise<RunImage[]> {
  const measured: { image: InspectedRunImage; sizes: number[] | null }[] = [];
  for (let offset = 0; offset < images.length; offset += 8) {
    measured.push(
      ...(await Promise.all(
        images.slice(offset, offset + 8).map(async (image) => {
          let stdout: string;
          try {
            ({ stdout } = await owner.run(
              [
                "image",
                "history",
                "--human=false",
                "--no-trunc",
                "--format",
                "{{.Size}}",
                image.id,
              ],
              { outputLimitBytes: 1_048_576 },
            ));
          } catch (error) {
            if (owner.signal.aborted) throw error;
            return { image, sizes: null };
          }
          const sizes = stdout.trim() === "" ? [] : stdout.trim().split("\n").map(Number);
          return {
            image,
            sizes: sizes.some((size) => !Number.isSafeInteger(size) || size < 0)
              ? null
              : sizes.reverse(),
          };
        }),
      )),
    );
  }
  const ambiguous = measured.filter(
    ({ image, sizes }) =>
      sizes !== null && sizes.filter((size) => size > 0).length !== image.layers.length,
  );
  const historyRead =
    ambiguous.length === 0
      ? { state: "read" as const, histories: new Map<string, readonly boolean[]>() }
      : await readImageLayerHistory(
          ambiguous.map(({ image }) => image),
          owner,
        );
  return measured.map(({ image, sizes }) => {
    const history = historyRead.state === "read" ? historyRead.histories.get(image.id) : undefined;
    const filesystem =
      sizes === null
        ? null
        : history === undefined
          ? sizes.filter((size) => size > 0)
          : sizes.filter((_, index) => history[index]);
    if (
      filesystem === null ||
      (history !== undefined && history.length !== sizes?.length) ||
      filesystem.length !== image.layers.length
    ) {
      logger?.warn(
        { imageId: image.id, tags: image.tags },
        "Cannot measure run image; disk usage is unknown.",
      );
      return { ...image, footprint: { state: "unmeasured" } };
    }
    return {
      ...image,
      footprint: {
        state: "measured",
        layers: image.layers.map((id, index) => ({ id, bytes: filesystem[index] ?? 0 })),
      },
    };
  });
}

type ImageLayer = { readonly id: string; readonly bytes: number };
type ImageFootprint =
  | { readonly state: "measured"; readonly layers: readonly ImageLayer[] }
  | { readonly state: "unmeasured" };
interface RunImage extends Omit<InspectedRunImage, "layers"> {
  readonly footprint: ImageFootprint;
}

interface InspectedRunImage {
  readonly id: string;
  readonly createdAt: number;
  readonly layers: readonly string[];
  readonly tags: readonly string[];
}

function parseRunImage(line: string): InspectedRunImage[] {
  if (line.trim() === "") return [];
  const parsed: unknown = JSON.parse(line);
  if (!Array.isArray(parsed)) return [];
  const [id, created, tags, layers] = parsed;
  if (typeof id !== "string" || typeof created !== "string") return [];
  return [
    {
      layers: Array.isArray(layers) ? layers.filter((layer) => typeof layer === "string") : [],
      createdAt: Date.parse(created),
      id,
      tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === "string") : [],
    },
  ];
}

function countRetainedBytes(images: readonly RunImage[], retained: Set<string>): number {
  let bytes = 0;
  for (const { footprint } of images) {
    if (footprint.state === "unmeasured") continue;
    const additional = unretainedLayers(footprint.layers, retained);
    bytes += additional.bytes;
    for (const chain of additional.chains) retained.add(chain);
  }
  return bytes;
}

function unretainedLayers(
  layers: readonly ImageLayer[],
  retained: ReadonlySet<string>,
): { readonly chains: readonly string[]; readonly bytes: number } {
  const chains: string[] = [];
  let bytes = 0;
  let layerChain: string | null = null;
  for (const layer of layers) {
    layerChain = layerChain === null ? layer.id : `${layerChain}/${layer.id}`;
    if (retained.has(layerChain)) continue;
    chains.push(layerChain);
    bytes += layer.bytes;
  }
  return { chains, bytes };
}

function diskBudgetBytes(): number {
  return positiveInteger("SWIZZLE_RUNNER_IMAGE_DISK_MB", DEFAULT_IMAGE_DISK_MB) * 1_048_576;
}

function runTagLast(left: string, right: string): number {
  return Number(RUN_TAG.test(left)) - Number(RUN_TAG.test(right));
}

function positiveInteger(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isSafeInteger(configured) && configured >= 1 ? configured : fallback;
}

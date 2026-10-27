// Disk accounting and retention of this stack's run images. Active and fresh images always stay.
import { RUN_IMAGE_DISK_DETAILS_LIMIT, type RunImageDisk } from "@swizzle/db";
import {
  CONTROL_TIMEOUT_MS,
  DOCKER_DEADLINES,
  type DockerDeadlines,
  DockerScope,
  removeAbandonedContainers,
  stackLabel,
  TRANSFER_TIMEOUT_MS,
} from "./docker-cli.js";
import { readImageLayerHistory } from "./docker-image-history.js";
import { AutomationRuntimeError } from "./errors.js";

export type PruneDeadlines = DockerDeadlines & { readonly pass: number };
export const PRUNE_DEADLINES: PruneDeadlines = {
  ...DOCKER_DEADLINES,
  pass: TRANSFER_TIMEOUT_MS + 12 * CONTROL_TIMEOUT_MS,
};

const DEFAULT_IMAGE_RETENTION_HOURS = 24;
const DEFAULT_IMAGE_DISK_MB = 20_480;
/** How often a worker prunes images that no live worker's active deployment keeps. */
export const RUN_IMAGE_PRUNE_INTERVAL_MS = 15 * 60 * 1_000;
/** Gives an assembly time to start its sandbox, after which Docker refuses to remove its image. */
const FRESH_IMAGE_MS = 10 * 60 * 1_000;
const RUN_TAG = /^swizzle-run:([0-9a-f]{24})$/u;
const IMAGE_FORMAT = `[{{json .Id}},{{json .Created}},{{json .RepoTags}},{{json .RootFS.Layers}}]`;

/**
 * Keeps tags selected from durable ownership and images within the assembly grace period.
 * Removes other stack images by age and disk budget, newest first. Docker refuses removal
 * while a container uses the image, so that image stays until a later pass. Resolves the count
 * removed and the bytes the keep set holds, which no budget bounds.
 */
export async function pruneRunImages(input: {
  readonly keep: ReadonlySet<string>;
  readonly logger?: ImagePruneLogger;
  readonly signal?: AbortSignal;
  readonly deadlines?: PruneDeadlines;
}): Promise<{ readonly removed: number; readonly disk: RunImageDisk }> {
  return await withPassOwner(
    async (owner) => {
      const docker: DockerCall = (args) => owner.run(args, { outputLimitBytes: 1_048_576 });
      const now = Date.now();
      const budgetBytes = diskBudgetBytes();
      await removeAbandonedContainers();
      const retained = new Set<string>();
      const active: RunImage[] = [];
      const fresh: RunImage[] = [];
      const candidates: RunImage[] = [];
      const listed = await listStackRunImages(docker);
      for (const image of await measureImageFootprints(listed, owner, input.logger)) {
        if (image.tags.some((tag) => input.keep.has(tag))) active.push(image);
        else if (now - image.createdAt < FRESH_IMAGE_MS) fresh.push(image);
        else candidates.push(image);
      }
      let bytes = 0;
      let hasUnmeasured = false;
      const retain = (image: RunImage) => {
        if (image.footprint.state === "unmeasured") {
          hasUnmeasured = true;
          return;
        }
        bytes += additionalImageBytes(image.footprint.layers, retained);
        for (const layer of image.footprint.layers) retained.add(layer.chain);
      };
      for (const image of active) retain(image);
      const activeBytes = bytes;
      const unmeasured = active.filter((image) => image.footprint.state === "unmeasured");
      const unmeasuredActiveImages = unmeasured
        .slice(0, RUN_IMAGE_DISK_DETAILS_LIMIT)
        .map(({ id, tags }) => ({
          id,
          tags: tags.filter((tag) => input.keep.has(tag)).slice(0, 1),
        }));
      const unmeasuredActiveImagesOmitted = unmeasured.length - unmeasuredActiveImages.length;
      for (const image of fresh) retain(image);
      const retentionMs =
        positiveInteger("SWIZZLE_RUNNER_IMAGE_RETENTION_HOURS", DEFAULT_IMAGE_RETENTION_HOURS) *
        3_600_000;
      let removed = 0;
      candidates.sort((left, right) => right.createdAt - left.createdAt);
      for (const image of candidates) {
        const { tags } = image;
        if (
          image.footprint.state === "measured" &&
          !hasUnmeasured &&
          now - image.createdAt < retentionMs &&
          bytes + additionalImageBytes(image.footprint.layers, retained) <= budgetBytes
        ) {
          retain(image);
          continue;
        }
        // The run tag goes last: an image a container uses keeps it when its removal fails.
        const references = tags.length === 0 ? [image.id] : [...tags].sort(runTagLast);
        try {
          await docker(["image", "rm", ...references]);
          removed += 1;
        } catch (error) {
          if (error instanceof AutomationRuntimeError) throw error;
          retain(image);
        }
      }
      input.signal?.throwIfAborted();
      return {
        removed,
        disk: { activeBytes, budgetBytes, unmeasuredActiveImages, unmeasuredActiveImagesOmitted },
      };
    },
    input.signal,
    input.deadlines,
  );
}

type ImagePruneLogger = { warn(...args: readonly unknown[]): void };

type DockerCall = (args: readonly string[]) => Promise<{ readonly stdout: string }>;

async function withPassOwner<T>(
  pass: (docker: DockerScope) => Promise<T>,
  signal?: AbortSignal,
  deadlines: PruneDeadlines = PRUNE_DEADLINES,
): Promise<T> {
  const owner = new DockerScope({
    timeoutMs: deadlines.pass,
    deadlines,
    containerName: null,
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    return await pass(owner);
  } finally {
    await owner.close();
  }
}

/** This stack's images, as Docker lists and inspects them. */
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
  // The CLI inspects its arguments sequentially. Bound parallel batches to fit the pass deadline.
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

/** History reports unpacked layer bytes on both Docker image stores, without packed blobs. */
async function measureImageFootprints(
  images: readonly InspectedRunImage[],
  owner: DockerScope,
  logger: ImagePruneLogger | undefined,
): Promise<RunImage[]> {
  const measured: { image: InspectedRunImage; sizes: number[] | null }[] = [];
  // Bound CLI processes while keeping a large inventory inside the prune pass deadline.
  for (let offset = 0; offset < images.length; offset += 8) {
    measured.push(
      ...(await Promise.all(
        images.slice(offset, offset + 8).map(async (image) => {
          const { stdout } = await owner.run(
            ["image", "history", "--human=false", "--no-trunc", "--format", "{{.Size}}", image.id],
            { outputLimitBytes: 1_048_576 },
          );
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
    // All unreadable footprints meet the same conservative retention policy here.
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
        layers: filesystem.map((bytes, index) => ({
          chain: image.layers.slice(0, index + 1).join("/"),
          bytes,
        })),
      },
    };
  });
}

type ImageLayer = { readonly chain: string; readonly bytes: number };
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

/** One line of IMAGE_FORMAT output; none when the line is not one. */
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

/** A diff ID shares storage only under the same sequence of parent layers. */
function additionalImageBytes(
  layers: readonly ImageLayer[],
  retained: ReadonlySet<string>,
): number {
  return layers.reduce((bytes, layer) => bytes + (retained.has(layer.chain) ? 0 : layer.bytes), 0);
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

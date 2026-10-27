// Docker history omits empty_layer flags. Saved image configs retain them, so ambiguous
// histories can be mapped without counting metadata-only entries as filesystem layers.
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { BoundedOutput } from "./bounded-output.js";
import type { DockerScope } from "./docker-cli.js";
import { AutomationRuntimeError } from "./errors.js";

const descriptor = z.object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) });
const metadata = z.union([
  z.object({
    rootfs: z.object({ diff_ids: z.array(z.string()) }),
    history: z.array(z.object({ empty_layer: z.boolean().default(false) })),
  }),
  z.object({ config: descriptor }),
  z.object({ manifests: z.array(descriptor) }),
]);
type Metadata = z.infer<typeof metadata>;

type ImageHistoryRead =
  | { readonly state: "read"; readonly histories: ReadonlyMap<string, readonly boolean[]> }
  | { readonly state: "unreadable" };

/**
 * Reads available config entries from one export; missing configs are absent from the map.
 * Layers pass through without writing to disk. A transfer timeout or invalid archive leaves
 * the batch unmeasured. Caller cancellation and other Docker failures reject the read.
 */
export async function readImageLayerHistory(
  images: readonly { readonly id: string; readonly layers: readonly string[] }[],
  owner: DockerScope,
): Promise<ImageHistoryRead> {
  const { Parser } = await import("tar");
  const records = new Map<string, Metadata>();
  const histories = new Map<string, readonly boolean[]>();
  let unreadable = false;
  const parser = new Parser({
    strict: true,
    onReadEntry: (entry) => {
      const digest = /^(?:blobs\/sha256\/)?([a-f0-9]{64})(?:\.json)?$/u.exec(entry.path)?.[1];
      if (digest === undefined || entry.size > 1_048_576) {
        entry.resume();
        return;
      }
      const body = new BoundedOutput(1_048_576);
      const decoder = new StringDecoder("utf8");
      entry.on("data", (chunk: Buffer) => body.append(decoder.write(chunk)));
      entry.on("end", () => {
        body.append(decoder.end());
        // A small layer blob can occupy the same namespace as metadata.
        let value: unknown;
        try {
          value = JSON.parse(body.value);
        } catch {
          return;
        }
        const parsed = metadata.safeParse(value);
        if (!parsed.success) return;
        records.set(`sha256:${digest}`, parsed.data);
        for (const image of images) {
          if (histories.has(image.id)) continue;
          const history = findHistory(records, image.id, image.layers);
          if (history !== undefined) histories.set(image.id, history);
        }
      });
    },
  });
  parser.on("error", () => {
    unreadable = true;
  });
  try {
    await owner.run(["image", "save", ...images.map((image) => image.id)], {
      deadline: "transfer",
      outputLimitBytes: 4096,
      onStdoutBytes: (chunk) => {
        parser.write(chunk);
        if (unreadable || histories.size === images.length) return "stop";
        return undefined;
      },
    });
    if (histories.size !== images.length) parser.end();
  } catch (error) {
    if (owner.signal.aborted) throw error;
    if (!(error instanceof AutomationRuntimeError && error.code === "DOCKER_TRANSFER_TIMEOUT"))
      throw error;
    unreadable = true;
  }
  owner.signal.throwIfAborted();
  return unreadable ? { state: "unreadable" } : { state: "read", histories };
}

/** Classic IDs name configs; containerd IDs can name manifests or multi-platform indexes. */
function findHistory(
  records: ReadonlyMap<string, Metadata>,
  digest: string,
  layers: readonly string[],
): readonly boolean[] | undefined {
  const record = records.get(digest);
  if (record === undefined) return undefined;
  if ("history" in record) {
    return record.rootfs.diff_ids.length === layers.length &&
      record.rootfs.diff_ids.every((id, index) => id === layers[index])
      ? record.history.map((entry) => !entry.empty_layer)
      : undefined;
  }
  if ("config" in record) return findHistory(records, record.config.digest, layers);
  for (const manifest of record.manifests) {
    const history = findHistory(records, manifest.digest, layers);
    if (history !== undefined) return history;
  }
  return undefined;
}

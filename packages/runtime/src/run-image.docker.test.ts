import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { create as tarCreate } from "tar";
import { expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { removeDockerImages, removeImagesWithLabel } from "../../../test/docker-images.js";
import { heldDeadlines, temporaryDirectory } from "../../../test/support.js";
import { createInstallGate } from "../test/install-gate.js";
import { DockerScope } from "./docker-cli.js";
import { pruneRunImages } from "./run-image-prune.js";
import { runAutomation } from "./runner.js";
import { sandboxRemovals } from "./sandbox.js";

const exec = promisify(execFile);
const MIB = 1_048_576;
const inspectedImage = z.object({
  Id: z.string(),
  RootFS: z.object({ Layers: z.array(z.string()) }),
});

it("lets a healthy run finish when another run exceeds its shared assembly log budget", async ({
  signal,
  onTestFinished,
  onTestFailed,
}) => {
  const deadlines = heldDeadlines();
  const directory = await temporaryDirectory("swizzle-image-isolation-");
  const stack = `image-isolation-${randomUUID()}`;
  vi.stubEnv("SWIZZLE_STACK", stack);
  vi.stubEnv("SWIZZLE_RUNNER_NETWORK", "none");
  const gate = await createInstallGate(directory, `local-${stack}`);
  const stop = new AbortController();
  const runSignal = AbortSignal.any([signal, stop.signal]);
  await writeFile(
    path.join(directory, "config.yaml"),
    [
      "name: image-isolation",
      "version: 1.0.0",
      "entrypoint: main.js",
      "trigger:",
      "  type: webhook",
      "runtime:",
      "  execution_mode: container",
      "  container:",
      `    base_image: ${gate.baseImage}`,
      "  permissions:",
      "    network: false",
      "  requirements:",
      "    node:",
      "      package_json: package.json",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(directory, "package.json"),
    '{"name":"image-isolation","version":"1.0.0","private":true}',
  );
  await writeFile(path.join(directory, "main.js"), "console.log(JSON.stringify({ ok: true }));");
  const start = (limit?: { outputLimitBytes: number }) => {
    let logs = "";
    let started = false;
    let join = () => {};
    const marker = new Promise<void>((resolve) => {
      join = resolve;
    });
    const result = runAutomation({
      automationDirectory: directory,
      environmentName: "local",
      runId: randomUUID(),
      abortSignal: runSignal,
      ...limit,
      onStderrChunk: (chunk) => {
        logs += chunk;
        if (logs === "install waiting\n") join();
      },
      onReady: async () => {
        started = true;
      },
    });
    let ended = false;
    const endedFirst = result.then(
      (outcome) => {
        ended = true;
        throw new Error(`The run ended before it joined the assembly: ${JSON.stringify(outcome)}`);
      },
      (error: unknown) => {
        ended = true;
        throw error;
      },
    );
    endedFirst.catch(() => {});
    return {
      result,
      joined: Promise.race([marker, endedFirst]),
      started: () => started,
      ended: () => ended,
    };
  };
  let healthy: ReturnType<typeof start> | undefined;
  let limited: ReturnType<typeof start> | undefined;
  const cleanup = new AbortController();
  onTestFailed(() => cleanup.abort());
  let teardown: Promise<void> | undefined;
  const finish = () => {
    teardown ??= (async () => {
      stop.abort();
      if (healthy?.ended() === false || limited?.ended() === false) deadlines.expire();
      await Promise.allSettled([healthy?.result, limited?.result]);
      try {
        await Promise.all([DockerScope.removals(), sandboxRemovals()]);
        const label = `swizzle.stack=local-${stack}`;
        const options = { signal: cleanup.signal };
        const { stdout } = await exec(
          "docker",
          ["container", "ls", "--all", "--quiet", "--filter", `label=${label}`],
          options,
        );
        const containers = stdout.split("\n").filter(Boolean);
        if (containers.length > 0)
          await exec("docker", ["container", "rm", "--force", "--volumes", ...containers], options);
        await removeImagesWithLabel(label, cleanup.signal);
      } finally {
        await gate.close(cleanup.signal);
      }
    })();
    return teardown;
  };
  onTestFinished(finish);
  try {
    await gate.build(signal);
    healthy = start();
    await healthy.joined;
    limited = start({ outputLimitBytes: 64 });
    await limited.joined;
    await gate.release(signal);
    expect(await limited.result).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      message: "Image assembly stderr exceeded 64 bytes.",
      stdout: "",
    });
    expect(await healthy.result).toMatchObject({ success: true, result: { ok: true } });
    expect([healthy.started(), limited.started()]).toEqual([true, false]);
  } finally {
    await finish();
  }
});

it("measures partially shared bases independently of excluded images, untagged images and inventory size", async ({
  signal,
}) => {
  heldDeadlines();
  const directory = await temporaryDirectory("swizzle-image-disk-docker-");
  const marker = randomUUID();
  const stack = `image-disk-${marker}`;
  const label = `swizzle.verify-image-disk=${marker}`;
  const docker = async (...args: string[]) => {
    try {
      return (await exec("docker", args, { maxBuffer: 8 * MIB, signal })).stdout;
    } catch (error) {
      if (error instanceof Error && error.message.includes("lease does not exist")) {
        throw new Error(
          `docker ${args[0]} ${args[1] ?? ""} lost its containerd lease: a concurrent \`docker image prune\` on this daemon removed it. Rerun once no prune runs.`,
          { cause: error },
        );
      }
      throw error;
    }
  };
  const inspect = async (reference: string) =>
    z.array(inspectedImage).parse(JSON.parse(await docker("image", "inspect", reference)))[0] ??
    (() => {
      throw new Error(`Image missing: ${reference}`);
    })();
  const fixture = await imageArchive(directory, marker);
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  const common = await fixture.layer("common", Buffer.alloc(8 * MIB, "a"));
  const zero = await fixture.layer("zero", Buffer.alloc(0));
  const customA = await fixture.layer("custom-a", Buffer.alloc(4 * MIB, "b"));
  const customB = await fixture.layer("custom-b", Buffer.alloc(6 * MIB, "c"));
  const tag = (name: string) =>
    `swizzle-run:${createHash("sha256").update(`${marker}:${name}`).digest("hex").slice(0, 24)}`;
  const baseCommon = tag("common");
  const ownedImages = new Set<string>();
  let loadingArchive = false;
  const imageLabels = (name: string, scope: string) => ({
    "swizzle.test.run": inject("dockerRun").run,
    "swizzle.stack": scope,
    "swizzle.verify-image-disk": marker,
    "swizzle.verify-image-name": name,
  });
  const add = async (name: string, layers: readonly LayerDescriptor[], scope: string) => {
    const reference = tag(name);
    ownedImages.add(reference);
    await fixture.image(reference, layers, imageLabels(name, scope), old);
    return reference;
  };
  const closeToDisk = (actual: number, expected: number) => {
    expect(Math.abs(actual - expected) / expected).toBeLessThan(0.03);
  };
  console.log(
    `Docker storage: ${(
      await docker("info", "--format", "{{.ServerVersion}} {{.Driver}} {{json .DriverStatus}}")
    ).trim()}`,
  );
  try {
    await add("common", [common, zero], `${stack}-excluded`);
    await add("base-a", [common, zero, customA], `${stack}-excluded`);
    await add("base-b", [common, zero, customB], `${stack}-excluded`);
    const a = tag("a");
    const b = tag("b");
    await add(
      "a",
      [common, zero, customA, await fixture.layer("a", Buffer.alloc(MIB, "d"))],
      stack,
    );
    await add(
      "b",
      [common, zero, customB, await fixture.layer("b", Buffer.alloc(MIB, "e"))],
      stack,
    );
    await add(
      "excluded",
      [common, zero, customA, await fixture.layer("excluded", Buffer.alloc(2 * MIB, "f"))],
      `${stack}-excluded`,
    );
    const largeStack = `${stack}-large`;
    const inventory = new Set<string>();
    for (let i = 0; i < 20; i++) {
      inventory.add(await add(`inventory-${i}`, [common, zero, customA], largeStack));
    }
    const cached = await add(
      "cached",
      [common, zero, customA, await fixture.layer("cached", Buffer.alloc(MIB, "g"))],
      stack,
    );
    const orphan = await fixture.layer("untagged", Buffer.alloc(MIB, "h"));
    const orphanReferences = await fixture.image(
      null,
      [common, zero, customA, orphan],
      imageLabels("untagged", stack),
      new Date().toISOString(),
    );
    const archive = await fixture.archive();
    loadingArchive = true;
    const loaded = await docker("image", "load", "--input", archive);
    const loadedImages = new Set(loaded.split("\n"));
    const orphanId = orphanReferences.find((id) => loadedImages.has(`Loaded image ID: ${id}`));
    if (!orphanId) throw new Error("The fixture archive did not load its untagged image.");
    ownedImages.add(orphanId);
    loadingArchive = false;
    const imageA = await inspect(a);
    const imageB = await inspect(b);
    expect(imageA.RootFS.Layers.filter((id) => imageB.RootFS.Layers.includes(id))).toEqual(
      (await inspect(baseCommon)).RootFS.Layers,
    );
    const expectedActive = 20 * MIB;
    vi.stubEnv("SWIZZLE_STACK", stack);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "100");
    const active = await pruneRunImages({ keep: new Set([a, b]), signal });
    expect(active.removed).toBe(0);
    console.log(`Active union: measured=${active.disk.activeBytes}, independent=${expectedActive}`);
    closeToDisk(active.disk.activeBytes, expectedActive);

    const cachedId = (await inspect(cached)).Id;
    const expectedRetained = expectedActive + 2 * MIB;
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(Math.ceil(expectedRetained / MIB) + 1));
    const retained = await pruneRunImages({ keep: new Set([a, b]), signal });
    expect(retained.removed).toBe(0);
    expect((await inspect(cached)).Id).toBe(cachedId);
    closeToDisk(retained.disk.activeBytes, expectedActive);

    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(Math.floor(expectedRetained / MIB) - 1));
    expect((await pruneRunImages({ keep: new Set([a, b]), signal })).removed).toBe(1);

    vi.stubEnv("SWIZZLE_STACK", largeStack);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "100");
    const large = await pruneRunImages({ keep: inventory, signal });
    expect(large.removed).toBe(0);
    closeToDisk(large.disk.activeBytes, 12 * MIB);
  } finally {
    if (loadingArchive) await removeImagesWithLabel(label);
    else await removeDockerImages(ownedImages);
  }
});

interface LayerDescriptor {
  readonly diffId: string;
  readonly blob: BlobDescriptor;
}

interface BlobDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
}

async function imageArchive(directory: string, marker: string) {
  const root = path.join(directory, "archive");
  const blobDirectory = "blobs/sha256";
  await mkdir(path.join(root, blobDirectory), { recursive: true });
  await writeFile(path.join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  const legacy: { Config: string; RepoTags: string[]; Layers: string[] }[] = [];
  const manifests: (BlobDescriptor & { annotations: Record<string, string> })[] = [];
  const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const file = (blob: BlobDescriptor) => `${blobDirectory}/${blob.digest.slice("sha256:".length)}`;
  const blob = async (suffix: string, bytes: Buffer): Promise<BlobDescriptor> => {
    const descriptor = {
      mediaType: `application/vnd.oci.image.${suffix}`,
      digest: digest(bytes),
      size: bytes.length,
    };
    await writeFile(path.join(root, file(descriptor)), bytes);
    return descriptor;
  };
  const json = (type: string, value: unknown) =>
    blob(`${type}+json`, Buffer.from(JSON.stringify(value)));
  return {
    layer: async (name: string, contents: Buffer): Promise<LayerDescriptor> => {
      const source = path.join(directory, name);
      await mkdir(source);
      const filename = `${marker}-${name}`;
      await writeFile(path.join(source, filename), contents);
      const layer = path.join(source, "layer.tar");
      await tarCreate({ cwd: source, file: layer, portable: true, mtime: new Date(0) }, [filename]);
      const bytes = await readFile(layer);
      return { diffId: digest(bytes), blob: await blob("layer.v1.tar+gzip", gzipSync(bytes)) };
    },
    image: async (
      tag: string | null,
      layers: readonly LayerDescriptor[],
      labels: Record<string, string>,
      created: string,
    ) => {
      const config = await json("config.v1", {
        created,
        architecture: process.arch === "arm64" ? "arm64" : "amd64",
        os: "linux",
        config: { Labels: labels },
        rootfs: { type: "layers", diff_ids: layers.map((layer) => layer.diffId) },
        history: layers.map(() => ({ created, created_by: "COPY fixture" })),
      });
      const manifest = await json("manifest.v1", {
        schemaVersion: 2,
        config,
        layers: layers.map((layer) => layer.blob),
      });
      manifests.push({
        ...manifest,
        annotations: tag === null ? {} : { "io.containerd.image.name": `docker.io/library/${tag}` },
      });
      legacy.push({
        Config: file(config),
        RepoTags: tag === null ? [] : [tag],
        Layers: layers.map((layer) => file(layer.blob)),
      });
      return [manifest.digest, config.digest];
    },
    archive: async () => {
      await writeFile(
        path.join(root, "index.json"),
        JSON.stringify({ schemaVersion: 2, manifests }),
      );
      await writeFile(path.join(root, "manifest.json"), JSON.stringify(legacy));
      const archive = path.join(directory, "images.tar");
      const entries = new Set([
        "oci-layout",
        "index.json",
        "manifest.json",
        ...manifests.map(file),
        ...legacy.flatMap(({ Config, Layers }) => [Config, ...Layers]),
      ]);
      await tarCreate({ cwd: root, file: archive }, [...entries]);
      return archive;
    },
  };
}

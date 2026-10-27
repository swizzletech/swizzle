import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { create as tarCreate } from "tar";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import { createInstallGate } from "../test/install-gate.js";
import { pruneRunImages } from "./run-image.js";
import { runAutomation } from "./runner.js";

const exec = promisify(execFile);
const MIB = 1_048_576;
const inspectedImage = z.object({
  Id: z.string(),
  RootFS: z.object({ Layers: z.array(z.string()) }),
});

it("lets a healthy run finish when another run exceeds its shared assembly log budget", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("swizzle-image-isolation-");
  const stack = `image-isolation-${randomUUID()}`;
  vi.stubEnv("SWIZZLE_STACK", stack);
  vi.stubEnv("SWIZZLE_RUNNER_NETWORK", "none");
  const gate = await createInstallGate(directory, `local-${stack}`);
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
  let healthyLogs = "";
  let limitedLogs = "";
  let healthyStarted = false;
  let limitedStarted = false;
  const healthy = runAutomation({
    automationDirectory: directory,
    environmentName: "local",
    runId: randomUUID(),
    onStderrChunk: (chunk) => {
      healthyLogs += chunk;
    },
    onReady: async () => {
      healthyStarted = true;
    },
  });
  let limited: ReturnType<typeof runAutomation> | undefined;
  try {
    await waitFor(signal, () => healthyLogs === "install waiting\n");
    limited = runAutomation({
      automationDirectory: directory,
      environmentName: "local",
      outputLimitBytes: 64,
      runId: randomUUID(),
      onStderrChunk: (chunk) => {
        limitedLogs += chunk;
      },
      onReady: async () => {
        limitedStarted = true;
      },
    });
    // The replay proves both runs joined the still-blocked assembly before it emits the overflow.
    await waitFor(signal, () => limitedLogs === "install waiting\n");
    await gate.release();
    expect(await limited).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      message: "Image assembly stderr exceeded 64 bytes.",
      stdout: "",
    });
    expect(await healthy).toMatchObject({ success: true, result: { ok: true } });
    expect([healthyStarted, limitedStarted]).toEqual([true, false]);
  } finally {
    await gate.release().catch(() => {});
    await Promise.allSettled([healthy, ...(limited === undefined ? [] : [limited])]);
    const images = (
      await exec("docker", [
        "image",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        `label=swizzle.stack=local-${stack}`,
      ])
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    if (images.length > 0) await exec("docker", ["image", "rm", "--force", ...images]);
    await gate.close();
  }
});

it("measures partially shared bases independently of excluded images, orphan commits and inventory size", async () => {
  const directory = await temporaryDirectory("swizzle-image-disk-docker-");
  const marker = randomUUID();
  const stack = `image-disk-${marker}`;
  const label = `swizzle.verify-image-disk=${marker}`;
  const docker = async (...args: string[]) => {
    try {
      return (await exec("docker", args, { maxBuffer: 8 * MIB, timeout: 180_000 })).stdout;
    } catch (error) {
      // containerd drops the lease of every import and commit in flight when anything on this
      // daemon runs `docker image prune`; the fixture cannot hold a lease of its own.
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
  const customA = await fixture.layer("custom-a", randomBytes(4 * MIB));
  const customB = await fixture.layer("custom-b", randomBytes(6 * MIB));
  const tag = (name: string) =>
    `swizzle-run:${createHash("sha256").update(`${marker}:${name}`).digest("hex").slice(0, 24)}`;
  const baseCommon = tag("common");
  const baseA = tag("base-a");
  const add = async (
    name: string,
    layers: readonly LayerDescriptor[],
    scope: string,
    created = old,
  ) => {
    const reference = tag(name);
    await fixture.image(
      reference,
      layers,
      {
        "swizzle.stack": scope,
        "swizzle.verify-image-disk": marker,
        "swizzle.verify-image-name": name,
      },
      created,
    );
    return reference;
  };
  const load = async () => docker("image", "load", "--input", await fixture.archive());
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
    await load();
    const a = tag("a");
    const b = tag("b");
    await add("a", [common, zero, customA, await fixture.layer("a", randomBytes(MIB))], stack, old);
    await add("b", [common, zero, customB, await fixture.layer("b", randomBytes(MIB))], stack, old);
    // This excluded image shares custom-a too. A daemon-wide shared size would undercount A.
    await add(
      "excluded",
      [common, zero, customA, await fixture.layer("excluded", randomBytes(2 * MIB))],
      `${stack}-excluded`,
    );
    await load();
    const imageA = await inspect(a);
    const imageB = await inspect(b);
    expect(imageA.RootFS.Layers.filter((id) => imageB.RootFS.Layers.includes(id))).toEqual(
      (await inspect(baseCommon)).RootFS.Layers,
    );
    // Payload sizes are independent of Docker's version-dependent packed/unpacked Size fields.
    const expectedActive = 20 * MIB;
    vi.stubEnv("SWIZZLE_STACK", stack);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "100");
    const active = await pruneRunImages({ keep: new Set([a, b]) });
    expect(active.removed).toBe(0);
    console.log(`Active union: measured=${active.disk.activeBytes}, independent=${expectedActive}`);
    closeToDisk(active.disk.activeBytes, expectedActive);

    const cached = tag("cached");
    await add(
      "cached",
      [common, zero, customA, await fixture.layer("cached", randomBytes(MIB))],
      stack,
      old,
    );
    await load();
    const source = path.join(directory, "untagged.bin");
    await writeFile(source, randomBytes(MIB));
    const assembly = (
      await docker(
        "create",
        "--network",
        "none",
        "--label",
        `swizzle.stack=${stack}`,
        "--label",
        "swizzle.verify-image-name=untagged",
        "--entrypoint",
        "/unused",
        baseA,
      )
    ).trim();
    try {
      await docker("cp", source, `${assembly}:/untagged`);
      await docker("commit", assembly);
    } finally {
      await docker("container", "rm", assembly);
    }
    const cachedId = (await inspect(cached)).Id;
    const expectedRetained = expectedActive + 2 * MIB;
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(Math.ceil(expectedRetained / MIB) + 1));
    const retained = await pruneRunImages({ keep: new Set([a, b]) });
    expect(retained.removed).toBe(0);
    expect((await inspect(cached)).Id).toBe(cachedId);
    closeToDisk(retained.disk.activeBytes, expectedActive);

    // The orphan also consumes private bytes: lowering the budget must evict the cached image.
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(Math.floor(expectedRetained / MIB) - 1));
    expect((await pruneRunImages({ keep: new Set([a, b]) })).removed).toBe(1);

    const largeStack = `${stack}-large`;
    const inventory = Array.from({ length: 128 }, (_, i) => tag(`inventory-${i}`));
    const importStarted = performance.now();
    for (const [i] of inventory.entries()) {
      await add(
        `inventory-${i}`,
        [
          common,
          zero,
          customA,
          await fixture.layer(`inventory-${i}`, Buffer.from(`source ${marker} ${i}`)),
        ],
        largeStack,
        old,
      );
      if ((i + 1) % 16 === 0) await load();
    }
    console.log(
      `Fixture import: 128 images in ${Math.round(performance.now() - importStarted)} ms.`,
    );
    vi.stubEnv("SWIZZLE_STACK", largeStack);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "100");
    const started = performance.now();
    const large = await pruneRunImages({ keep: new Set(inventory) });
    const elapsed = performance.now() - started;
    expect(large.removed).toBe(0);
    expect(large.disk.activeBytes).toBeGreaterThan(12 * MIB);
    expect(large.disk.activeBytes).toBeLessThan(100 * MIB);
    expect(elapsed).toBeLessThan(60_000);
    console.log(
      `Real Docker: excluded-image sharing and fresh untagged commits pass; 128 images measured in ${Math.round(elapsed)} ms.`,
    );
  } finally {
    const ids = [
      ...new Set(
        (
          await docker(
            "image",
            "ls",
            "--all",
            "--filter",
            `label=${label}`,
            "--quiet",
            "--no-trunc",
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean),
      ),
    ];
    if (ids.length > 0) await docker("image", "rm", ...ids);
  }
}, 600_000);

interface LayerDescriptor {
  readonly diffId: string;
  readonly file: string;
}

/** A Docker save archive, accepted by both classic and containerd image stores. */
async function imageArchive(directory: string, marker: string) {
  const root = path.join(directory, "archive");
  await mkdir(root);
  const manifests: { Config: string; RepoTags: string[]; Layers: string[] }[] = [];
  const json = async (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const file = `${createHash("sha256").update(bytes).digest("hex")}.json`;
    await writeFile(path.join(root, file), bytes);
    return file;
  };
  return {
    layer: async (name: string, contents: Buffer): Promise<LayerDescriptor> => {
      const source = path.join(directory, name);
      await mkdir(source);
      const filename = `${marker}-${name}`;
      await writeFile(path.join(source, filename), contents);
      const file = `${name}.tar`;
      await tarCreate({ cwd: source, file: path.join(root, file), portable: true }, [filename]);
      const bytes = await readFile(path.join(root, file));
      return {
        file,
        diffId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      };
    },
    image: async (
      tag: string,
      layers: readonly LayerDescriptor[],
      labels: Record<string, string>,
      created: string,
    ) => {
      const config = await json({
        created,
        architecture: process.arch === "arm64" ? "arm64" : "amd64",
        os: "linux",
        config: { Labels: labels },
        rootfs: { type: "layers", diff_ids: layers.map((layer) => layer.diffId) },
        history: layers.map(() => ({ created, created_by: "COPY fixture" })),
      });
      manifests.push({
        Config: config,
        RepoTags: [tag],
        Layers: layers.map((layer) => layer.file),
      });
    },
    archive: async () => {
      await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifests));
      const file = path.join(directory, "images.tar");
      await tarCreate({ cwd: root, file }, ["."]);
      manifests.length = 0;
      return file;
    },
  };
}

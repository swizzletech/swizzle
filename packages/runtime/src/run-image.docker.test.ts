import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { create as tarCreate } from "tar";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { heldDeadlines, temporaryDirectory, waitFor } from "../../../test/support.js";
import { createInstallGate } from "../test/install-gate.js";
import { pruneRunImages } from "./run-image-prune.js";
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
  // Other worktrees share this Docker daemon: its calls take as long as they need, up to the ceiling.
  heldDeadlines();
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
  // A run joins the gated assembly when it replays the install's marker; ending first fails the test.
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
      abortSignal: signal,
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
  const owned = async (kind: "container" | "image") =>
    (
      await exec("docker", [
        kind,
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
  // When a Docker step fails, the runtime reassembles once in a new container, gated again; it
  // also outlives a run that ended before the release. Release whichever assembly waits until done.
  const releaseUntil = (done: () => boolean | Promise<boolean>) =>
    waitFor(signal, async () => {
      await gate.release().catch(() => {});
      return await done();
    });
  const healthy = start();
  let limited: ReturnType<typeof start> | undefined;
  const runsEnded = () => healthy.ended() && (limited?.ended() ?? true);
  try {
    await healthy.joined;
    limited = start({ outputLimitBytes: 64 });
    // Its replay proves both runs joined the still-blocked assembly before it emits the overflow.
    await limited.joined;
    await releaseUntil(runsEnded);
    expect(await limited.result).toMatchObject({
      success: false,
      code: "PROCESS_OUTPUT_LIMIT_EXCEEDED",
      message: "Image assembly stderr exceeded 64 bytes.",
      stdout: "",
    });
    expect(await healthy.result).toMatchObject({ success: true, result: { ok: true } });
    expect([healthy.started(), limited.started()]).toEqual([true, false]);
  } finally {
    // Removing a waiting assembly would make the runtime reassemble it: let it finish instead.
    await releaseUntil(async () => runsEnded() && (await owned("container")).length === 0);
    const images = await owned("image");
    if (images.length > 0) await exec("docker", ["image", "rm", "--force", ...images]);
    await gate.close();
  }
});

it("measures partially shared bases independently of excluded images, orphan commits and inventory size", async ({
  signal,
}) => {
  // Other worktrees share this Docker daemon: its calls take as long as they need, up to the ceiling.
  heldDeadlines();
  const directory = await temporaryDirectory("swizzle-image-disk-docker-");
  const marker = randomUUID();
  const stack = `image-disk-${marker}`;
  const label = `swizzle.verify-image-disk=${marker}`;
  // Fixture commands stop with the test; `cleanup` removes what they made also after a timeout.
  const dockerUntil =
    (stop?: AbortSignal) =>
    async (...args: string[]) => {
      try {
        return (await exec("docker", args, { maxBuffer: 8 * MIB, signal: stop })).stdout;
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
  const docker = dockerUntil(signal);
  const cleanup = dockerUntil();
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
    const active = await pruneRunImages({ keep: new Set([a, b]), signal });
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
      await cleanup("container", "rm", assembly);
    }
    const cachedId = (await inspect(cached)).Id;
    const expectedRetained = expectedActive + 2 * MIB;
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(Math.ceil(expectedRetained / MIB) + 1));
    const retained = await pruneRunImages({ keep: new Set([a, b]), signal });
    expect(retained.removed).toBe(0);
    expect((await inspect(cached)).Id).toBe(cachedId);
    closeToDisk(retained.disk.activeBytes, expectedActive);

    // The orphan also consumes private bytes: lowering the budget must evict the cached image.
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(Math.floor(expectedRetained / MIB) - 1));
    expect((await pruneRunImages({ keep: new Set([a, b]), signal })).removed).toBe(1);

    const largeStack = `${stack}-large`;
    // Twenty images span two inspect batches and three rounds of history reads.
    const inventory = Array.from({ length: 20 }, (_, i) => tag(`inventory-${i}`));
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
    }
    await load();
    vi.stubEnv("SWIZZLE_STACK", largeStack);
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "100");
    const large = await pruneRunImages({ keep: new Set(inventory), signal });
    expect(large.removed).toBe(0);
    // Each image adds a source of a few bytes to the common and custom-a layers they all share.
    closeToDisk(large.disk.activeBytes, 12 * MIB);
  } finally {
    const ids = [
      ...new Set(
        (
          await cleanup(
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
    if (ids.length > 0) await cleanup("image", "rm", ...ids);
  }
});

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

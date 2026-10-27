import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AUTOMATION_RUNTIME_PROFILE_DEFAULT } from "@swizzle/config";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { temporaryDirectory, waitFor } from "../../../test/support.js";
import { createAutomationFixture } from "../test/platform-harness.js";
import { readExecutionSource } from "./execution-wire.js";
import { createArtifactStorageForReference } from "./storage.js";
import { loadAutomationDefinition } from "./validation.js";

const execFileAsync = promisify(execFile);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const IMAGE_MIB = 300;

describe("run images of prepared deployments", () => {
  it("keeps active deployments' run images past the retention window and holds the rest to the disk budget", {
    timeout: 30_000,
  }, async ({ signal }) => {
    const budgetMiB = 2 * IMAGE_MIB + 100;
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(budgetMiB));
    const docker = await fakeDockerImages();
    const { deploy, run } = await platformWithPreparation();
    // Waits until a prune pass listed the stack's images after the newest assembly.
    const pruned = (commits: number) =>
      waitFor(signal, async () => (await docker.listingsAfterCommit(commits)) > 0);

    await deploy("kept");
    await waitFor(signal, async () => (await docker.commits()).length === 1);
    await docker.age(25 * HOUR_MS);
    await deploy("churn");
    await waitFor(signal, async () => (await docker.commits()).length === 2);
    const first = await run("kept");
    await pruned(2);
    const second = await run("kept");

    expect([first, second]).toEqual([{ image: undefined }, { image: undefined }]);

    for (const version of [2, 3]) {
      await docker.age(11 * MINUTE_MS);
      await deploy("churn", `console.log('{"v":${version}}');\n`);
      await waitFor(signal, async () => (await docker.commits()).length === version + 1);
      await waitFor(signal, async () => (await docker.totalMiB()) <= budgetMiB);
    }
    const [kept, , replaced, churn] = await docker.commits();
    // The pass after the last preparation removes the replaced deployment's image.
    await waitFor(signal, async () => !(await docker.imageIds()).includes(replaced ?? ""));

    await waitFor(signal, async () => (await docker.totalMiB()) <= budgetMiB);
    expect(await docker.tagged()).toEqual(new Set([kept, churn]));
    expect(await docker.totalMiB()).toBeLessThanOrEqual(budgetMiB);
    // An assembled image counts against the budget once the pass after its assembly ran.
    expect(await docker.peakMiB()).toBeLessThanOrEqual(budgetMiB + IMAGE_MIB);
  });
});

it("retains a shared released image while one-bundle polls learn other active tags", {
  timeout: 30_000,
}, async ({ signal }) => {
  vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "1");
  const docker = await fakeDockerImages();
  const { deploy, logged } = await platformWithPreparation();
  await deploy("z-kept");
  await waitFor(signal, async () => logged.length > 0 && (await docker.commits()).length === 1);
  const [kept] = await docker.commits();
  await docker.age(25 * HOUR_MS);
  // Sorted active snapshots deliver a-other before the replacement z-kept.
  await deploy("a-other");
  await deploy("z-kept");
  await waitFor(
    signal,
    () => logged.filter((line) => line === "Prepared deployment.").length === 3,
  );
  expect(await docker.imageIds()).toContain(kept);
  expect(await docker.commits()).toHaveLength(2);
});

describe("a prune pass", () => {
  // The owner sees the measurement in Settings > Workers when the active bytes pass the budget.
  it("keeps an active image past the disk budget, removes an inactive one and measures both", async () => {
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "100");
    const docker = await fakeDockerImages();
    const active = `swizzle-run:${"a".repeat(24)}`;
    const inactive = `swizzle-run:${"b".repeat(24)}`;
    for (const tag of [active, inactive]) {
      await docker.run(["create", "--name", "assembly", "--label", "swizzle.stack=stack-a"]);
      const image = (await docker.run(["commit", "assembly"])).trim();
      await docker.run(["tag", image, tag]);
    }
    await docker.age(25 * HOUR_MS);
    const { pruneRunImages } = await freshRuntime();

    expect(await pruneRunImages({ keep: new Set([active]) })).toEqual({
      removed: 1,
      disk: { activeBytes: IMAGE_MIB * 1_048_576, budgetBytes: 100 * 1_048_576 },
    });

    expect(await docker.imageIds()).toEqual([(await docker.commits())[0]]);
  });

  it("skips pruning when the durable keep set cannot be read", async ({ signal }) => {
    const docker = await fakeDockerImages();
    await docker.run(["create", "--name", "assembly", "--label", "swizzle.stack=stack-a"]);
    const image = (await docker.run(["commit", "assembly"])).trim();
    await docker.run(["tag", image, `swizzle-run:${"a".repeat(24)}`]);
    await docker.age(25 * HOUR_MS);
    const { startDeploymentPreparation } = await freshRuntime();
    const warnings: string[] = [];
    const preparation = startDeploymentPreparation({
      poll: async () => ({ activeIds: [], deployments: [] }),
      recordImage: async () => {},
      keptImages: async () => {
        throw new Error("database unavailable");
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn: (...args) => {
          warnings.push(String(args.at(-1)));
        },
      },
    });
    onTestFinished(() => preparation.close());

    await waitFor(signal, () => warnings.length > 0);

    expect(await docker.imageIds()).toEqual([image]);
  });

  it("a local container run cannot prune an aged worker image with the same configured stack", async () => {
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "1");
    const docker = await fakeDockerImages();
    await docker.run(["create", "--name", "assembly", "--label", "swizzle.stack=stack-a"]);
    const image = (await docker.run(["commit", "assembly"])).trim();
    await docker.run(["tag", image, `swizzle-run:${"a".repeat(24)}`]);
    await docker.age(25 * HOUR_MS);
    const directory = await createAutomationFixture({
      name: "local-cleanup",
      configLines: ["runtime:", "  execution_mode: container"],
      triggerLines: ["  type: webhook", "  path: /local-cleanup"],
    });
    const { runAutomation } = await freshRuntime();

    expect(
      (await runAutomation({ automationDirectory: directory, environmentName: "local" })).success,
    ).toBe(true);

    expect(await docker.imageIds()).toContain(image);
    expect(await docker.commits()).toHaveLength(2);
  });

  // An assembly committed and tagged the image; the run that needs it has not started its sandbox.
  it("keeps an image an assembly just made, also past the disk budget", async () => {
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", "1");
    const docker = await fakeDockerImages();
    await docker.run(["create", "--name", "assembly", "--label", "swizzle.stack=stack-a"]);
    const image = (await docker.run(["commit", "assembly"])).trim();
    await docker.run(["tag", image, `swizzle-run:${"a".repeat(24)}`]);
    const { pruneRunImages } = await freshRuntime();

    await pruneRunImages({ keep: new Set() });

    expect(await docker.imageIds()).toEqual([image]);
    expect(await docker.tagged()).toEqual(new Set([image]));
  });

  // Runs of replaced deployments and local runs assemble images no active deployment keeps.
  it("holds images no deployment keeps to the disk budget once their runs started", async () => {
    vi.stubEnv("SWIZZLE_RUNNER_IMAGE_DISK_MB", String(2 * IMAGE_MIB + 100));
    const docker = await fakeDockerImages();
    const { ensureRunImage, pruneRunImages, runImageRecipe, runImageTag } = await freshRuntime();
    const jump = useMovableClock();
    for (const version of [1, 2, 3]) {
      const directory = await createAutomationFixture({
        configLines: ["runtime:", "  execution_mode: container"],
        name: `inactive-${version}`,
        triggerLines: ["  type: webhook", `  path: /inactive-${version}`],
      });
      const definition = await loadAutomationDefinition(directory);
      const recipe = runImageRecipe(definition);
      const tag = await runImageTag(directory, recipe);
      await ensureRunImage({ automationDirectory: directory, recipe, tag });
    }
    jump(11 * MINUTE_MS);

    await pruneRunImages({ keep: new Set() });

    expect(await docker.totalMiB()).toBe(2 * IMAGE_MIB);
  });
});

describe("the recorded images of active deployments", () => {
  it("stay kept while a preparation stalls", { timeout: 30_000 }, async ({ signal }) => {
    const docker = await fakeDockerImages();
    const { deploy, otherWorkerPass, run, recordedCount } = await platformWithPreparation();
    const jump = useMovableClock();

    await deploy("kept");
    await waitFor(signal, async () => (await docker.commits()).length === 1);
    const [kept = ""] = await docker.commits();
    await waitFor(signal, () => recordedCount() === 1);
    await docker.holdAssembly(2);
    await deploy("slow");
    await waitFor(signal, async () => (await docker.assemblies()) === 2);
    jump(50 * MINUTE_MS);
    await otherWorkerPass();
    jump(20 * MINUTE_MS);
    await docker.age(25 * HOUR_MS);
    await otherWorkerPass();
    await docker.releaseAssembly(2);
    await waitFor(signal, async () => (await docker.commits()).length === 2);

    expect(await docker.imageIds()).toContain(kept);
    expect(await run("kept")).toEqual({ image: undefined });
  });

  it("include the image of a deployment whose preparation failed before it knew the tag", {
    timeout: 30_000,
  }, async ({ signal }) => {
    const docker = await fakeDockerImages();
    // The worker reads its artifact store from here; an empty one fails the source download.
    const environment = { ...process.env };
    const { deploy, logged, otherWorkerPass, run, recordedCount } =
      await platformWithPreparation(environment);
    const artifacts = environment.SWIZZLE_ARTIFACTS_DIR;
    environment.SWIZZLE_ARTIFACTS_DIR = await temporaryDirectory("swizzle-no-artifacts-");
    const jump = useMovableClock();

    await deploy("late");
    await waitFor(signal, () => logged.includes("Preparing or pruning deployments failed."));
    environment.SWIZZLE_ARTIFACTS_DIR = artifacts;
    expect((await run("late")).image).toBeTypeOf("number");
    jump(16 * MINUTE_MS);
    // The retried preparation records the tag before another worker prunes.
    await waitFor(signal, () => recordedCount() === 1);
    jump(50 * MINUTE_MS);
    await docker.age(25 * HOUR_MS);
    await otherWorkerPass();

    expect(await docker.imageIds()).toEqual(await docker.commits());
    expect(await run("late")).toEqual({ image: undefined });
  });

  it("are known before the first pass of a restarted worker", { timeout: 30_000 }, async ({
    signal,
  }) => {
    const docker = await fakeDockerImages();
    const { deploy, logged, restart, recordedCount } = await platformWithPreparation();
    const jump = useMovableClock();

    await deploy("kept");
    await waitFor(signal, async () => (await docker.commits()).length === 1);
    const [kept = ""] = await docker.commits();
    await waitFor(signal, () => recordedCount() === 1);
    await waitFor(signal, () => logged.includes("Prepared deployment."));
    await restart();
    jump(2 * HOUR_MS);
    await docker.age(25 * HOUR_MS);
    await waitFor(
      signal,
      () => logged.filter((line) => line === "Prepared deployment.").length === 2,
    );

    expect(await docker.commits()).toEqual([kept]);
    expect(await docker.imageIds()).toEqual([kept]);
  });

  // The run image tag hashes the source and recipe, so a deploy of the same source shares it.
  it("include an image that the next deployment of the same source reuses", {
    timeout: 30_000,
  }, async ({ signal }) => {
    const docker = await fakeDockerImages();
    const { deploy, logged, run, recordedCount } = await platformWithPreparation();

    await deploy("kept");
    await waitFor(signal, async () => (await docker.commits()).length === 1);
    const [kept = ""] = await docker.commits();
    await waitFor(signal, () => recordedCount() === 1);
    await docker.age(25 * HOUR_MS);
    await deploy("kept");
    await waitFor(
      signal,
      () => logged.filter((line) => line === "Prepared deployment.").length === 2,
    );

    expect(await run("kept")).toEqual({ image: undefined });
    expect(await docker.commits()).toEqual([kept]);
  });
});

/** Moves the preparation retry and pruning clocks without slowing the test. */
function useMovableClock(): (ms: number) => void {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return (ms) => vi.setSystemTime(Date.now() + ms);
}

/** A fresh module graph: closing a preparation closes its graph's Docker scopes for good. */
async function freshRuntime() {
  vi.resetModules();
  return {
    ...(await import("./deployment-preparation.js")),
    ...(await import("../../../test/platform.js")),
    ...(await import("./run-image.js")),
    ...(await import("./runner.js")),
  };
}

/**
 * A test platform whose worker prepares its deployments, as the worker service starts it,
 * with `environment` as the worker's environment and its log messages in `logged`.
 */
async function platformWithPreparation(environment: NodeJS.ProcessEnv = { ...process.env }) {
  const { testPlatform, pruneRunImages, startDeploymentPreparation } = await freshRuntime();
  const artifactsDirectory = path.join(await temporaryDirectory("swizzle-platform-"), "artifacts");
  environment.SWIZZLE_ARTIFACTS_DIR = artifactsDirectory;
  const platform = await testPlatform({ artifactsDirectory });
  const logged: string[] = [];
  const log = (...args: readonly unknown[]) => logged.push(String(args.at(-1)));
  const records = new Map<string, string>();
  const keptImages = async () => {
    const active = await platform.store.listActiveDeployments();
    const versionKey = (deployment: { sourceHash: string; config: unknown }) =>
      JSON.stringify([deployment.sourceHash, deployment.config]);
    const activeVersions = new Set(active.map(versionKey));
    const latest = new Map<string, { seq: number; tag: string }>();
    for (const [id, tag] of records) {
      const deployment = await platform.store.getDeploymentById(id);
      if (deployment === null || !activeVersions.has(versionKey(deployment))) continue;
      if ((latest.get(versionKey(deployment))?.seq ?? -1) < deployment.seq)
        latest.set(versionKey(deployment), { seq: deployment.seq, tag });
    }
    return [...latest.values()].map(({ tag }) => tag);
  };
  const start = (begin: typeof startDeploymentPreparation) =>
    begin({
      recordImage: async (id, tag) => {
        records.set(id, tag);
      },
      keptImages,
      logger: { debug: log, error: log, info: log, warn: log },
      poll: async (knownIds) => {
        const active = (await platform.store.listActiveDeployments()).filter(
          (deployment) => deployment.config.runtime.profile === AUTOMATION_RUNTIME_PROFILE_DEFAULT,
        );
        const deployments = [];
        for (const deployment of active
          .filter((deployment) => !knownIds.includes(deployment.deploymentId))
          .slice(0, 1)) {
          deployments.push(
            await createArtifactStorageForReference(deployment, {
              environment,
            }).withSourceDirectory(deployment, async (directory) => ({
              deploymentId: deployment.deploymentId,
              automationName: deployment.automationName,
              deployedAt: deployment.deployedAt,
              files: await readExecutionSource(directory),
            })),
          );
        }
        return { activeIds: active.map((deployment) => deployment.deploymentId), deployments };
      },
    });
  let preparation = start(startDeploymentPreparation);
  onTestFinished(() => preparation.close());
  const fixtures = new Map<string, string>();
  return {
    logged,
    /**
     * Stops the worker's preparation and starts it again as a new worker process would. The
     * platform's own runs share the stopped process's Docker scopes, so a test runs none after it.
     */
    restart: async () => {
      await preparation.close();
      preparation = start((await freshRuntime()).startDeploymentPreparation);
    },
    /** A pass of another worker on the same daemon, which keeps none of these images. */
    otherWorkerPass: async () => pruneRunImages({ keep: new Set((await keptImages()) ?? []) }),
    recordedCount: () => records.size,
    deploy: async (name: string, mainJs?: string) => {
      const directory =
        fixtures.get(name) ??
        (await createAutomationFixture({
          configLines: ["runtime:", "  execution_mode: container"],
          name,
          triggerLines: ["  type: webhook", `  path: /${name}`],
        }));
      fixtures.set(name, directory);
      if (mainJs !== undefined) await writeFile(path.join(directory, "main.js"), mainJs);
      // Forced, so a deploy of unchanged source still makes a new deployment.
      await platform.deployAutomationToPlatform({
        automationDirectory: directory,
        deploymentId: randomUUID(),
        environment: "local",
        force: true,
      });
    },
    /** Runs the automation once and reports how long it waited for its run image. */
    run: async (automationName: string) => {
      const runId = randomUUID();
      await platform.enqueuePlatformRun({ automationName, environment: "local", runId });
      await platform.processNextPlatformRun();
      const record = await platform.getPlatformRun(runId);
      expect(record.status).toBe("succeeded");
      const phases = record.executions[0]?.metadata.phases as { image?: number } | undefined;
      return { image: phases?.image };
    },
  };
}

/**
 * A `docker` on PATH with an image store in files, for the calls run image assembly, sandboxes
 * and pruning make. Commit makes an image of IMAGE_MIB that carries its container's labels; tag,
 * image rm, image inspect and image ls act on the store as the daemon does. The create of the nth
 * assembly container waits while the test holds that assembly. After every call the fake records
 * the peak size of all images. A shell script, not a Node one, so
 * each call stays fast while other test files load the host.
 */
async function fakeDockerImages() {
  const bin = await temporaryDirectory("swizzle-fake-docker-");
  const state = path.join(bin, "state");
  const log = path.join(bin, "calls.log");
  await writeFile(
    path.join(bin, "docker"),
    `#!/bin/sh
state='${state}'
mkdir -p "$state/images" "$state/tags" "$state/containers"
echo "$*" >> '${log}'
# The image id a reference names: an id or a tag.
image_of() {
  case "$1" in
    sha256:*) [ -d "$state/images/$1" ] && echo "$1" ;;
    *) cat "$state/tags/$1" 2>/dev/null ;;
  esac
}
tags_of() { grep -lx "$1" "$state"/tags/* 2>/dev/null | sed 's|.*/||'; }
remove_image() { for tag in $(tags_of "$1"); do rm "$state/tags/$tag"; done; rm -r "$state/images/$1"; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
status=0
case "$1 $2" in
  "version --format") echo 29.9.1 ;;
  create*)
    name='' labels=''
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name=$2; shift ;;
        --label) labels="$labels\${labels:+,}\\"\${2%%=*}\\":\\"\${2#*=}\\""; shift ;;
      esac
      shift
    done
    echo "{$labels}" > "$state/containers/$name"
    case "$name" in
      swizzle-image-*)
        echo >> "$state/assemblies"
        n=$(wc -l < "$state/assemblies")
        while [ -e "$state/hold-$n" ]; do sleep 0.05; done ;;
    esac ;;
  commit*)
    eval container=\\\${$#}
    id=sha256:$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')
    mkdir "$state/images/$id"
    cp "$state/containers/$container" "$state/images/$id/labels"
    date +%s > "$state/images/$id/created"
    echo ${IMAGE_MIB * 1_048_576} > "$state/images/$id/size"
    echo "$id" >> "$state/commits"
    echo "$id" ;;
  tag*) id=$(image_of "$2") || exit 1; echo "$id" > "$state/tags/$3" ;;
  "image inspect")
    shift 2
    format=''
    for reference; do
      if [ "$format" = next ]; then format=yes; continue; fi
      if [ "$reference" = --format ]; then format=next; continue; fi
      id=$(image_of "$reference") || { echo "Error: No such image: $reference" >&2; exit 1; }
      [ -n "$format" ] || continue
      tags=$(tags_of "$id" | sed 's/.*/"&"/' | paste -s -d , -)
      echo "[\\"$id\\",\\"$(iso "$(cat "$state/images/$id/created")")\\",$(cat "$state/images/$id/size"),[$tags]]"
    done ;;
  "system dial-stdio")
    read -r request
    printf 'HTTP/1.0 200 OK\\r\\n\\r\\n['
    comma=''
    for directory in "$state"/images/*/; do
      [ -d "$directory" ] || continue
      id=$(basename "$directory")
      printf '%s{"Id":"%s","Size":%s,"SharedSize":0}' "$comma" "$id" "$(cat "$directory/size")"
      comma=','
    done
    printf ']' ;;
  "container inspect") echo sha256:base ;;
  "image ls")
    label=$(echo "$*" | sed -n 's/.*--filter label=\\([^ ]*\\).*/\\1/p')
    for directory in "$state"/images/*/; do
      [ -d "$directory" ] || continue
      grep -qF "\\"\${label%%=*}\\":\\"\${label#*=}\\"" "$directory/labels" && basename "$directory"
    done ;;
  "image rm")
    shift 2
    for reference; do
      id=$(image_of "$reference") || { status=1; continue; }
      case "$reference" in
        sha256:*)
          if [ "$(tags_of "$id" | wc -l)" -gt 1 ]; then echo "conflict: $id has several tags" >&2; status=1; continue; fi
          remove_image "$id" ;;
        *) rm "$state/tags/$reference"; [ -n "$(tags_of "$id")" ] || rm -r "$state/images/$id" ;;
      esac
    done ;;
  exec*) cat >/dev/null; echo '{"ok":true}' ;;
esac
total=$(cat "$state"/images/*/size 2>/dev/null | awk '{ sum += $1 } END { print sum + 0 }')
[ "$total" -le "$(cat "$state/peak" 2>/dev/null || echo 0)" ] || echo "$total" > "$state/peak"
exit $status
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("SWIZZLE_STACK", "stack-a");
  const lines = async () => (await readFile(log, "utf8").catch(() => "")).split("\n");
  const images = async () =>
    (await readdir(path.join(state, "images")).catch(() => [])).map((id) =>
      path.join(state, "images", id),
    );
  const mib = async (file: string) =>
    Math.round(Number(await readFile(file, "utf8").catch(() => "0")) / 1_048_576);
  // Sandboxes are removed in the background. The test waits for that removal, or it deletes this
  // fake mid-call and the removal's retry lands in a later test's log.
  onTestFinished(async ({ signal }) => {
    await waitFor(signal, async () => {
      const logged = await lines();
      return logged.every((call) => {
        const created = /^create --name (swizzle-\S+)/u.exec(call)?.[1];
        return created === undefined || logged.includes(`rm --force ${created}`);
      });
    });
  });
  return {
    /** Calls the fake as the runtime would, for state a test sets up. */
    run: async (args: readonly string[]) =>
      (await execFileAsync(path.join(bin, "docker"), [...args])).stdout,
    /** Makes the create of the `n`th assembly container wait until releaseAssembly(n). */
    holdAssembly: (n: number) => writeFile(path.join(state, `hold-${n}`), ""),
    releaseAssembly: (n: number) => rm(path.join(state, `hold-${n}`)),
    /** How many assembly containers were created, a held one included. */
    assemblies: async () =>
      (await readFile(path.join(state, "assemblies"), "utf8").catch(() => "")).split("\n").length -
      1,
    /** The ids of the images commit made, oldest first. */
    commits: async () =>
      (await readFile(path.join(state, "commits"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
    /** How many `image ls` calls came after the `commits`th commit. */
    listingsAfterCommit: async (commits: number) => {
      const logged = await lines();
      let seen = 0;
      let listings = 0;
      for (const call of logged) {
        if (call.startsWith("commit")) seen += 1;
        else if (seen >= commits && call.startsWith("image ls")) listings += 1;
      }
      return listings;
    },
    /** Moves every image's creation `ms` into the past. */
    age: async (ms: number) => {
      for (const image of await images()) {
        const created = Number(await readFile(path.join(image, "created"), "utf8"));
        await writeFile(path.join(image, "created"), `${created - Math.round(ms / 1_000)}\n`);
      }
    },
    imageIds: async () => (await images()).map((image) => path.basename(image)),
    /** The ids of the images that still carry a tag. */
    tagged: async () => {
      const tags = await readdir(path.join(state, "tags")).catch(() => []);
      return new Set(
        await Promise.all(
          tags.map(async (tag) => (await readFile(path.join(state, "tags", tag), "utf8")).trim()),
        ),
      );
    },
    totalMiB: async () => {
      let total = 0;
      for (const image of await images()) total += await mib(path.join(image, "size"));
      return total;
    },
    peakMiB: () => mib(path.join(state, "peak")),
  };
}

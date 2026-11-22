import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { addAbortListener, once } from "node:events";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { collectWorkerCapabilities, readRunnerTools } from "@swizzle/runtime";
import { expect, inject, it } from "vitest";
import { removeImagesWithLabel } from "../test/docker-images.js";
import { temporaryDirectory } from "../test/support.js";
import { type PreparedStack, readCompose, writeCompose } from "./stack-images.ts";

const execute = promisify(execFile);
const fixture = new URL("../test/fixtures/runner-upgrade/", import.meta.url);
const driver = new URL("prepare.mjs", fixture).pathname;

async function savedRunnerInventory(
  image: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const archive = path.join(directory, "image.tar");
  await execute("docker", ["image", "save", "--output", archive, image], { signal });
  const { stdout: manifestJson } = await execute("tar", ["-xOf", archive, "manifest.json"], {
    signal,
  });
  const manifest: unknown = JSON.parse(manifestJson);
  const layers: unknown = Array.isArray(manifest) ? manifest[0]?.Layers : undefined;
  const layer: unknown = Array.isArray(layers) ? layers.at(-1) : undefined;
  if (typeof layer !== "string") throw new Error("Saved fixture image has no filesystem layer.");
  await execute("tar", ["-xf", archive, "-C", directory, layer], { signal });
  const { stdout } = await execute(
    "tar",
    ["-xOf", path.join(directory, layer), "etc/swizzle/runner-tools.json"],
    { signal },
  );
  return stdout;
}

async function prepareFixture(
  root: string,
  output: string,
  signal: AbortSignal,
  tags?: string,
  env = process.env,
): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [driver, root, output, ...(tags ? [tags] : [])], {
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  using _abort = addAbortListener(signal, () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code, terminationSignal] = await once(child, "close");
  signal.throwIfAborted();
  if (code !== 0) {
    throw Object.assign(
      new Error(`Preparing fixture failed: ${code ?? terminationSignal}\n${stderr}`),
      {
        stderr,
      },
    );
  }
  return stderr;
}

it.concurrent.for([
  { target: "runner", tags: "local", outcome: "prepared" },
  { target: "worker", tags: "local", outcome: "prepared" },
  { target: "runner", tags: "directory", outcome: "prepared" },
  { target: "worker", tags: "local", outcome: "build-error" },
] as const)(
  "keeps preparation results when interleaved before its $target extension ($tags tags, $outcome)",
  async ({ target, tags, outcome }, { expect, onTestFinished, signal }) => {
    const directory = await temporaryDirectory("swizzle-interleaved-packages-", onTestFinished);
    const project = `swizzle-interleaved-${randomUUID()}`;
    const command = async (...args: string[]) =>
      (await execute("docker", args, { maxBuffer: 64 * 1024 * 1024, signal })).stdout.trim();
    const docker = (await execute("which", ["docker"])).stdout.trim();
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await copyFile(new URL("interleave-docker.mjs", fixture), path.join(bin, "docker"));
    const roots = [path.join(directory, "a"), path.join(directory, "b")] as const;
    for (const [index, root] of roots.entries()) {
      const identity = index === 0 ? "a" : "b";
      await mkdir(path.join(root, "infra/docker"), { recursive: true });
      await mkdir(path.join(root, "scripts"));
      await copyFile(
        new URL("stack-images.ts", import.meta.url),
        path.join(root, "scripts/stack-images.ts"),
      );
      await copyFile(new URL("interleaved/Dockerfile", fixture), path.join(root, "Dockerfile"));
      for (const release of ["a", "b"]) {
        await writeFile(
          path.join(root, `jq-${release}.json`),
          JSON.stringify({ binaries: [{ name: `runner-${release}`, version: null }] }),
        );
      }
      const extension = path.join(root, "infra/docker/Dockerfile.runner");
      await copyFile(new URL("interleaved/Dockerfile.runner", fixture), extension);
      if (identity === "a" && outcome === "build-error") {
        await writeFile(
          extension,
          `${await readFile(extension, "utf8")}\nCOPY missing-package /missing-package\n`,
        );
      }
      await writeFile(path.join(root, ".env"), "");
      await writeFile(
        path.join(root, "infra/docker/compose.yml"),
        JSON.stringify({
          name: project,
          services: Object.fromEntries(
            ["runner-base", "worker"].map((name) => [
              name,
              {
                build: {
                  context: root,
                  dockerfile: "Dockerfile",
                  target: name,
                  args: {
                    VERSION: identity,
                    SWIZZLE_RUNNER_APT_PACKAGES: "jq",
                    SWIZZLE_DOCKER_TEST_RUN: inject("dockerRun").run,
                  },
                },
              },
            ]),
          ),
        }),
      );
    }
    const suffix = tags === "local" ? "local" : "p".repeat(90);
    const first = path.join(directory, "prepared-a", suffix, "compose.json");
    const second = path.join(directory, "prepared-b", suffix, "compose.json");
    const cleanupCalls = path.join(directory, "cleanup-calls");
    const preparation = prepareFixture(roots[0], first, signal, tags, {
      ...process.env,
      BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      INTERLEAVE_TARGET: target,
      INTERLEAVE_PREPARE: driver,
      INTERLEAVE_ROOT: roots[1],
      INTERLEAVE_OUTPUT: second,
      INTERLEAVE_PATH: process.env.PATH,
      INTERLEAVE_DOCKER: docker,
      INTERLEAVE_TAG: tags,
      ...(target === "worker" ? { INTERLEAVE_CLEANUP_CALLS: cleanupCalls } : {}),
    });
    let cleanup: Promise<void> | undefined;
    const finish = () =>
      (cleanup ??= preparation
        .catch(() => {})
        .then(() => removeImagesWithLabel(`com.docker.compose.project=${project}`)));
    onTestFinished(finish);
    try {
      if (outcome === "build-error") {
        await expect(preparation).rejects.toMatchObject({
          stderr: expect.stringContaining("Error: Command failed: docker buildx build"),
        });
      } else {
        const stderr = await preparation;
        if (target === "worker") expect(stderr).toContain("Could not remove temporary stock image");
        for (const [file, identity] of [
          [first, "a"],
          [second, "b"],
        ] as const) {
          const prepared = JSON.parse(await readFile(file, "utf8"));
          const runner = prepared.services["runner-base"].image;
          const worker = prepared.services.worker.image;
          const inventories = [];
          for (const image of [runner, worker]) {
            expect(
              await command(
                "image",
                "inspect",
                "--format",
                '{{index .Config.Labels "fixture.release"}}',
                image,
              ),
            ).toBe(identity);
            const inventory = await savedRunnerInventory(image, directory, signal);
            expect(JSON.parse(inventory).binaries).toContainEqual({
              name: `runner-${identity}`,
              version: null,
            });
            inventories.push(inventory);
          }
          expect(inventories[0]).toBe(inventories[1]);
        }
        for (const name of ["runner-base", "worker"]) {
          const tags = await command("image", "ls", "--format", "{{.Tag}}", `${project}-${name}`);
          expect(tags.split("\n").sort()).toEqual([
            suffix === "local" ? "local" : `${suffix}-compose`,
            `${suffix}-packages`,
          ]);
        }
      }
      if (target === "worker") {
        expect((await readFile(cleanupCalls, "utf8")).trim().split("\n")).toEqual([
          expect.stringContaining(`${project}-runner-base:`),
          expect.stringContaining(`${project}-worker:`),
        ]);
      }
    } finally {
      await finish();
    }
  },
);

it("keeps local runner tags stable and tools available through just upgrade", async () => {
  const directory = await temporaryDirectory("swizzle-runner-upgrade-");
  const root = path.join(directory, "installed");
  const project = `swizzle-runner-packages-${randomUUID()}`;
  await mkdir(path.join(root, "infra/docker"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  for (const file of [
    "mise.toml",
    ".env.example",
    "scripts/stack.ts",
    "scripts/stack-images.ts",
    "scripts/upgrade.ts",
    "scripts/init-env.ts",
    "scripts/env-file.ts",
    "infra/docker/Dockerfile.runner",
    "infra/docker/runner-tools.mjs",
  ]) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  const environment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: project,
    MISE_TRUSTED_CONFIG_PATHS: root,
    SWIZZLE_DOCKER_TEST_RUN: inject("dockerRun").run,
  };
  const command = async (program: string, ...args: string[]) =>
    (await execute(program, args, { cwd: root, env: environment })).stdout.trim();
  const git = (...args: string[]) => command("git", ...args);
  const compose = (...args: string[]) =>
    command(
      "docker",
      "compose",
      "--env-file",
      ".env",
      "-f",
      "infra/docker/compose.yml",
      "--profile",
      "stack",
      ...args,
    );
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await copyFile(
    new URL("../test/fixtures/runner-upgrade/justfile", import.meta.url),
    path.join(root, "justfile"),
  );
  await copyFile(
    new URL("../test/fixtures/runner-upgrade/Dockerfile", import.meta.url),
    path.join(root, "Dockerfile"),
  );
  await git("init", "--initial-branch=fixture");
  await git("config", "user.name", "Runner upgrade test");
  await git("config", "user.email", "test@swizzle.test");
  const composeTemplate = await readFile(
    new URL("../test/fixtures/runner-upgrade/compose.yml", import.meta.url),
    "utf8",
  );
  for (const version of ["1.0.3", "1.0.4"]) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version, type: "module" }));
    await writeFile(
      path.join(root, "infra/docker/compose.yml"),
      composeTemplate.replace("VERSION: &version 1.0.3", `VERSION: &version ${version}`),
    );
    await git("add", ".");
    await git("commit", "-m", `Fixture release ${version}`);
    await git("tag", `v${version}`);
  }
  const origin = path.join(directory, "origin.git");
  await command("git", "clone", "--bare", root, origin);
  await git("remote", "add", "origin", origin);
  await git("checkout", "--detach", "v1.0.3");
  const envFile = path.join(root, ".env");
  const localTags = (service: string) =>
    command("docker", "image", "ls", "--format", "{{.Tag}}", `${project}-${service}`);
  const observe = async (version: string) => {
    const container = await compose("ps", "--all", "--quiet", "runner-base");
    const runner = await command("docker", "inspect", "--format", "{{.Image}}", container);
    const [jqVersion, ...runnerRecord] = (
      await command(
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "sh",
        runner,
        "-ec",
        "jq --version; cat /etc/swizzle/runner-tools.json",
      )
    ).split("\n");
    expect(jqVersion).toMatch(/^jq-1\./u);
    expect(
      await command(
        "docker",
        "image",
        "inspect",
        "--format",
        '{{index .Config.Labels "fixture.release"}}',
        runner,
      ),
    ).toBe(version);
    const [workerBase, ...workerRecord] = (
      await compose(
        "exec",
        "-T",
        "worker",
        "sh",
        "-ec",
        "printenv SWIZZLE_RUNNER_BASE_IMAGE; cat /etc/swizzle/runner-tools.json",
      )
    ).split("\n");
    const inventory = workerRecord.join("\n");
    expect(JSON.parse(inventory).binaries).toContainEqual({
      name: "jq",
      version: expect.stringMatching(/^1\./u),
    });
    const record = path.join(directory, "runner-tools.json");
    await writeFile(record, inventory);
    const capabilities = await collectWorkerCapabilities(await readRunnerTools(record));
    expect(capabilities).toMatchObject({
      binaries: expect.arrayContaining([{ name: "jq", version: expect.stringMatching(/^1\./u) }]),
      dependencyPackaging: { node: true, python: false },
      languages: [
        { name: "node", version: "26.12.1" },
        { name: "typescript", version: "26.12.1" },
      ],
    });
    expect(workerBase).toBe(runner);
    expect(runnerRecord.join("\n")).toBe(inventory);
    return runner;
  };
  try {
    await command("just", "init-env");
    await writeFile(
      envFile,
      (await readFile(envFile, "utf8"))
        .replace(/^COMPOSE_PROJECT_NAME=.*$/mu, `COMPOSE_PROJECT_NAME=${project}`)
        .replace(/^SWIZZLE_RUNNER_APT_PACKAGES=.*$/mu, "SWIZZLE_RUNNER_APT_PACKAGES=jq"),
    );
    await command("just", "stack");
    const first = await observe("1.0.3");
    for (const service of ["runner-base", "worker"]) {
      expect((await localTags(service)).split("\n").sort()).toEqual(["local", "local-packages"]);
    }
    await writeFile(
      envFile,
      (await readFile(envFile, "utf8")).replace(
        "SWIZZLE_RUNNER_APT_PACKAGES=jq",
        "SWIZZLE_RUNNER_APT_PACKAGES=jq curl",
      ),
    );
    await command("just", "stack");
    const before = await observe("1.0.3");
    expect(before).not.toBe(first);
    for (const service of ["runner-base", "worker"]) {
      expect((await localTags(service)).split("\n").sort()).toEqual(["local", "local-packages"]);
    }
    const originalEnv = await readFile(envFile, "utf8");
    const stock = await command(
      "docker",
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      `${project}-runner-base:local`,
    );
    expect(await git("status", "--porcelain")).toBe("");

    expect(await command("just", "upgrade", "v1.0.4")).toContain("\n/health reports 1.0.4\n");

    expect(await git("rev-parse", "HEAD")).toBe(await git("rev-parse", "v1.0.4"));
    expect(await observe("1.0.4")).not.toBe(before);
    expect(await readFile(envFile, "utf8")).toBe(originalEnv);
    expect(await git("status", "--porcelain")).toBe("");
    expect(
      await command(
        "docker",
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        `${project}-runner-base:local`,
      ),
    ).toBe(stock);
  } finally {
    const owned = ["--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`];
    const containers = (await command("docker", "ps", ...owned)).split("\n").filter(Boolean);
    if (containers.length > 0) await command("docker", "rm", "--force", "--volumes", ...containers);
    await removeImagesWithLabel(`com.docker.compose.project=${project}`);
  }
});

it("starts with cached dependency images when their registry is unreachable", async ({
  signal,
}) => {
  const root = await temporaryDirectory("swizzle-offline-stack-");
  const project = `swizzle-offline-${randomUUID()}`;
  const image = `127.0.0.1:1/${project}:cached`;
  await mkdir(path.join(root, "infra/docker"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  for (const file of [
    "justfile",
    "mise.toml",
    ".env.example",
    "scripts/stack.ts",
    "scripts/stack-images.ts",
    "scripts/init-env.ts",
    "scripts/env-file.ts",
  ]) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  await writeFile(path.join(root, "package.json"), '{"version":"1.0.4","type":"module"}');
  await writeFile(
    path.join(root, "infra/docker/compose.yml"),
    JSON.stringify({
      name: project,
      services: { probe: { image, network_mode: "none", command: ["tail", "-f", "/dev/null"] } },
    }),
  );
  await execute("git", ["init", "--initial-branch=fixture", root]);
  await execute("git", [
    "-C",
    root,
    "-c",
    "user.name=Image test",
    "-c",
    "user.email=test@swizzle.test",
    "commit",
    "--allow-empty",
    "-m",
    "Installed source",
  ]);
  const alpine = "alpine:3.24.3";
  try {
    await execute("docker", ["image", "inspect", alpine]);
  } catch {
    await execute("docker", ["pull", alpine]);
  }
  await writeFile(path.join(root, "Dockerfile"), `FROM ${alpine}\n`);
  await execute("docker", ["build", "--label", inject("dockerRun").label, "--tag", image, root]);
  try {
    const options = { cwd: root, env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: root } };
    await execute("mise", ["exec", "--", "just", "init-env"], options);
    await writeFile(
      path.join(root, ".env"),
      (await readFile(path.join(root, ".env"), "utf8")).replace(
        /^COMPOSE_PROJECT_NAME=.*$/mu,
        `COMPOSE_PROJECT_NAME=${project}`,
      ),
    );
    await execute("mise", ["exec", "--", "just", "stack"], {
      cwd: root,
      env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: root },
    });
    const { stdout: state } = await execute("docker", [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.State}}",
    ]);
    expect(state.trim()).toBe("running");
    const output = path.join(root, "prepared/compose.json");
    await prepareFixture(root, output, signal);
    const prepared = JSON.parse(await readFile(output, "utf8"));
    expect(prepared.services.probe).toMatchObject({ pull_policy: "never" });
    const { stdout: id } = await execute("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image,
    ]);
    expect(prepared.services.probe.image).toBe(id.trim());
  } finally {
    await execute("docker", [
      "compose",
      "-f",
      path.join(root, "infra/docker/compose.yml"),
      "down",
      "--volumes",
    ]);
    await execute("docker", ["image", "rm", image]);
  }
});

it("preserves literal dollars and shell variables when starting a resolved Compose file", async () => {
  const root = await temporaryDirectory("swizzle-image-config-");
  const envFile = path.join(root, ".env");
  const file = path.join(root, "prepared.json");
  await mkdir(path.join(root, "infra/docker"), { recursive: true });
  await writeFile(envFile, "");
  await writeFile(
    path.join(root, "infra/docker/compose.yml"),
    JSON.stringify({
      name: `swizzle-image-config-${randomUUID()}`,
      services: {
        probe: {
          image: "alpine:3.24.3",
          network_mode: "none",
          labels: [inject("dockerRun").label],
          environment: { VALUE: "literal$$VALUE" },
          command: ["sh", "-c", 'printf "%s\\n" "$$VALUE"'],
        },
      },
    }),
  );
  writeCompose(readCompose({ root, envFile }), file);
  try {
    const { stdout } = await execute("docker", [
      "compose",
      "-f",
      file,
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "probe",
    ]);
    expect(stdout).toBe("literal$VALUE\n");
  } finally {
    await execute("docker", ["compose", "-f", file, "down", "--volumes"]);
  }
});

it("retains the first prepared source image after a rebuild moves its local tag", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("swizzle-source-image-retention-");
  const root = path.join(directory, "source");
  const project = `swizzle-source-retention-${randomUUID()}`;
  await mkdir(path.join(root, "infra/docker"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await copyFile(
    new URL("stack-images.ts", import.meta.url),
    path.join(root, "scripts/stack-images.ts"),
  );
  await writeFile(path.join(root, ".env"), "");
  await writeFile(
    path.join(root, "infra/docker/compose.yml"),
    JSON.stringify({
      name: project,
      services: { probe: { build: { context: root, dockerfile: "Dockerfile", target: "probe" } } },
    }),
  );
  const prepare = async (revision: string): Promise<string> => {
    await writeFile(
      path.join(root, "Dockerfile"),
      `FROM scratch AS probe\nLABEL fixture.revision=${revision} ${inject("dockerRun").label}\n`,
    );
    const output = path.join(directory, revision, "compose.json");
    await prepareFixture(root, output, signal, "local");
    const prepared = JSON.parse(await readFile(output, "utf8"));
    expect(prepared.services.probe.image).toMatch(/^sha256:[a-f0-9]{64}$/u);
    return prepared.services.probe.image;
  };
  const inspect = async (reference: string) =>
    (
      await execute(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          '{{.Id}} {{index .Config.Labels "fixture.revision"}}',
          reference,
        ],
        { signal },
      )
    ).stdout.trim();
  try {
    const first = await prepare("first");
    expect(await inspect(first)).toBe(`${first} first`);
    const second = await prepare("second");
    expect(await inspect(`${project}-probe:local`)).toBe(`${second} second`);
    expect(await inspect(first)).toBe(`${first} first`);
  } finally {
    await removeImagesWithLabel(`com.docker.compose.project=${project}`);
  }
});

it("reuses development image tags and preserves prepared upgrade images with serial builds", async ({
  signal,
}) => {
  const directory = await temporaryDirectory("swizzle-legacy-image-");
  const root = path.join(directory, "checkout");
  const project = `swizzle-legacy-image-${randomUUID()}`;
  const envFile = path.join(root, ".env");
  const dockerfile = String.raw`FROM alpine:3.24.3 AS probe
LABEL ${inject("dockerRun").label}
RUN printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$*" > /turbo-args' > /usr/local/bin/pnpm && chmod +x /usr/local/bin/pnpm
RUN pnpm exec turbo run build
CMD ["cat", "/turbo-args"]
`;
  await mkdir(path.join(root, "infra/docker"), { recursive: true });
  await writeFile(envFile, "");
  await mkdir(path.join(root, "scripts"));
  for (const file of [
    "justfile",
    "mise.toml",
    ".env.example",
    "scripts/stack.ts",
    "scripts/stack-images.ts",
    "scripts/init-env.ts",
    "scripts/env-file.ts",
  ]) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  await writeFile(path.join(root, "Dockerfile"), dockerfile);
  await writeFile(path.join(root, "package.json"), '{"version":"1.0.3"}');
  await writeFile(path.join(root, ".gitignore"), ".env\n");
  await writeFile(
    path.join(root, "infra/docker/compose.yml"),
    JSON.stringify({
      name: project,
      services: {
        probe: {
          command: ["tail", "-f", "/dev/null"],
          network_mode: "none",
          build: { context: root, dockerfile: "Dockerfile", target: "probe" },
        },
      },
    }),
  );
  await execute("git", ["init", "--initial-branch=fixture", root]);
  await execute("git", ["-C", root, "add", "."]);
  await execute("git", [
    "-C",
    root,
    "-c",
    "user.name=Image test",
    "-c",
    "user.email=test@swizzle.test",
    "commit",
    "-m",
    "Earlier release build recipe",
  ]);
  const prepareProbe = async (phase: "prepared" | "upgrade") => {
    const file = path.join(directory, phase, "compose.json");
    await prepareFixture(root, file, signal);
    const images: PreparedStack["images"] = JSON.parse(
      await readFile(`${file}.images.json`, "utf8"),
    );
    return images.probe;
  };
  try {
    const image = await prepareProbe("prepared");
    expect(image).toBeDefined();
    if (image === undefined) throw new Error("No prepared probe image.");
    const { stdout } = await execute("docker", ["run", "--rm", "--network", "none", image]);
    expect(stdout).toBe("exec turbo run build --concurrency=1\n");
    expect(await readFile(path.join(root, "Dockerfile"), "utf8")).toBe(dockerfile);
    await rm(envFile);
    const options = { cwd: root, env: { ...process.env, MISE_TRUSTED_CONFIG_PATHS: root } };
    await execute("mise", ["x", "--", "just", "init-env"], options);
    await writeFile(
      envFile,
      (await readFile(envFile, "utf8")).replace(
        /^COMPOSE_PROJECT_NAME=.*$/mu,
        `COMPOSE_PROJECT_NAME=${project}`,
      ),
    );
    await execute("mise", ["x", "--", "just", "stack"], options);
    const first = (
      await execute("docker", ["image", "inspect", "--format", "{{.Id}}", `${project}-probe:local`])
    ).stdout.trim();
    await writeFile(path.join(root, "Dockerfile"), `${dockerfile}LABEL revision=second\n`);
    await execute("mise", ["x", "--", "just", "stack"], options);
    const second = (
      await execute("docker", ["image", "inspect", "--format", "{{.Id}}", `${project}-probe:local`])
    ).stdout.trim();
    expect(second).not.toBe(first);
    const tags = (
      await execute("docker", ["image", "ls", "--format", "{{.Tag}}", `${project}-probe`])
    ).stdout
      .trim()
      .split("\n")
      .sort();
    expect(tags).toEqual(["local", "prepared-compose"]);
    await writeFile(path.join(root, "Dockerfile"), `${dockerfile}LABEL revision=upgrade\n`);
    const upgradedImage = await prepareProbe("upgrade");
    expect(
      (
        await execute("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          `${project}-probe:prepared-compose`,
        ])
      ).stdout.trim(),
    ).toBe(image);
    expect(
      (
        await execute("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          `${project}-probe:local`,
        ])
      ).stdout.trim(),
    ).toBe(second);
    if (upgradedImage === undefined) throw new Error("No upgrade image");
    expect(
      (
        await execute("docker", [
          "image",
          "inspect",
          "--format",
          '{{index .Config.Labels "revision"}}',
          upgradedImage,
        ])
      ).stdout.trim(),
    ).toBe("upgrade");
  } finally {
    const owned = ["--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`];
    try {
      const containers = (await execute("docker", ["ps", ...owned])).stdout
        .split("\n")
        .filter(Boolean);
      if (containers.length > 0) await execute("docker", ["rm", "--force", ...containers]);
    } finally {
      await removeImagesWithLabel(`com.docker.compose.project=${project}`);
    }
  }
});

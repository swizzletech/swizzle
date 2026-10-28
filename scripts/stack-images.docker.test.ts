import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";
import { prepareImages, readCompose, writeCompose } from "./stack-images.ts";

const execute = promisify(execFile);

it("starts with cached dependency images when their registry is unreachable", async () => {
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
  await execute("docker", ["pull", "alpine:3.24.3"]);
  await execute("docker", ["tag", "alpine:3.24.3", image]);
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
    prepareImages({ root, envFile: path.join(root, ".env") }, output);
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

it("reuses development image tags and preserves prepared upgrade images with serial builds", async () => {
  const directory = await temporaryDirectory("swizzle-legacy-image-");
  const root = path.join(directory, "checkout");
  const project = `swizzle-legacy-image-${randomUUID()}`;
  const envFile = path.join(root, ".env");
  const dockerfile = String.raw`FROM alpine:3.24.3 AS probe
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
  try {
    // The prepared Dockerfile lives outside the source context, as an archived upgrade does.
    const prepared = prepareImages(
      { root, envFile },
      path.join(directory, "prepared/compose.json"),
    );
    const image = prepared.images.probe;
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
    const upgrade = prepareImages({ root, envFile }, path.join(directory, "upgrade/compose.json"));
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
    const upgradedImage = upgrade.images.probe;
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
      const ids = (await execute("docker", ["image", "ls", ...owned])).stdout
        .split("\n")
        .filter(Boolean);
      if (ids.length > 0) await execute("docker", ["image", "rm", "--force", ...ids]);
    }
  }
});

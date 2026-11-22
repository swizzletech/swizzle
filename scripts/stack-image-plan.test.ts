import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { diskSpace } from "../test/disk-space.js";
import { temporaryDirectory } from "../test/support.js";
import { prepareImages } from "./stack-images.ts";

const execute = promisify(execFile);
const imageId = `sha256:${"a".repeat(64)}`;
const version = "1.0.3";

async function fixture() {
  diskSpace(64);
  const root = await temporaryDirectory("swizzle-image-plan-");
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, "infra/docker"), { recursive: true });
  await mkdir(path.join(root, ".github/workflows"), { recursive: true });
  for (const file of ["stack-images.ts", "release-images.ts"]) {
    await copyFile(new URL(file, import.meta.url), path.join(root, file));
  }
  await writeFile(path.join(root, ".github/workflows/images.yml"), "");
  await writeFile(path.join(root, "infra/docker/Dockerfile"), "FROM scratch AS web\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version, type: "module" }));
  const envFile = path.join(root, ".env");
  await writeFile(envFile, "");
  const configure = async (webBuild: Record<string, unknown> = {}) =>
    writeFile(
      path.join(root, "compose.json"),
      JSON.stringify({
        name: "fixture",
        services: {
          api: {
            build: {
              context: root,
              dockerfile: "infra/docker/Dockerfile",
              target: "service",
              args: { WORKSPACE: "@swizzle/api" },
            },
          },
          web: {
            build: {
              context: root,
              dockerfile: "infra/docker/Dockerfile",
              target: "web",
              args: { VITE_API_BASE_URL: "https://dashboard.invalid/$${project}" },
              ...webBuild,
            },
          },
        },
      }),
    );
  await configure();
  const calls = path.join(root, "calls");
  await writeFile(
    path.join(root, "bin/docker"),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/calls"
case "$1 $2" in
  "compose --env-file") cat "$FIXTURE_ROOT/compose.json" ;;
  "info --format") echo /tmp ;;
  "pull registry.invalid/swizzle-api:${version}") printf '%s\\n' pulled ;;
  "image inspect") printf '%s\\n' '${imageId}' ;;
  "tag ${imageId}") ;;
  "buildx build")
    while [ "$1" != --iidfile ]; do shift; done
    printf '%s\\n' '${imageId}' > "$2" ;;
  "buildx bake") ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(root, "bin/cosign"),
    '#!/bin/sh\nprintf "cosign %s\\n" "$*" >> "$FIXTURE_ROOT/calls"\n',
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${path.join(root, "bin")}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("FIXTURE_ROOT", root);
  vi.stubEnv("SWIZZLE_IMAGE_REGISTRY", "registry.invalid");
  await execute("git", ["init", "--initial-branch=fixture"], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Image test",
      "-c",
      "user.email=test@swizzle.test",
      "commit",
      "--allow-empty",
      "-m",
      "Release",
    ],
    { cwd: root },
  );
  return {
    root,
    source: { root, envFile, version },
    configure,
    calls: async () => (await readFile(calls, "utf8")).trim().split("\n"),
    release: (command: string) =>
      execute(process.execPath, ["release-images.ts", command, version, "images.json"], {
        cwd: root,
      }),
  };
}

it("pulls stock images and builds a dashboard with its custom API URL", async () => {
  const { root, source, calls } = await fixture();
  const output = path.join(root, "prepared", "compose.json");
  expect(prepareImages(source, output).images).toEqual({ api: imageId, web: imageId });
  const commands = await calls();
  expect(commands.filter((call) => call.startsWith("pull "))).toEqual([
    "pull registry.invalid/swizzle-api:1.0.3",
  ]);
  expect(
    commands.filter((call) => call.startsWith("buildx build ") || call.startsWith("tag ")),
  ).toEqual([
    `buildx build --load --iidfile ${root}/prepared/web.iid --file ${root}/infra/docker/Dockerfile --target web --label com.docker.compose.project=fixture --label com.docker.compose.service=web --build-arg VITE_API_BASE_URL=https://dashboard.invalid/\${project} ${root}`,
    `tag ${imageId} fixture-web:prepared-compose`,
  ]);
  expect(JSON.parse(await readFile(output, "utf8")).services).toEqual({
    api: { image: imageId, pull_policy: "never" },
    web: { image: imageId, pull_policy: "never" },
  });
});

it("publishes the release build plan and signs each published digest", async () => {
  const { root, calls, release } = await fixture();
  await release("plan");
  const plan = JSON.parse(await readFile(path.join(root, "images.json"), "utf8"));
  expect(plan.group).toEqual({ default: { targets: ["api", "web"] } });
  expect(plan.target).toMatchObject({
    api: {
      context: ".",
      dockerfile: "infra/docker/Dockerfile",
      target: "service",
      args: { WORKSPACE: "@swizzle/api" },
      tags: ["registry.invalid/swizzle-api:1.0.3"],
      platforms: ["linux/amd64", "linux/arm64"],
      attest: ["type=provenance,mode=max"],
    },
    web: {
      context: ".",
      dockerfile: "infra/docker/Dockerfile",
      target: "web",
      args: { VITE_API_BASE_URL: "/api" },
      tags: ["registry.invalid/swizzle-web:1.0.3"],
      platforms: ["linux/amd64", "linux/arm64"],
      attest: ["type=provenance,mode=max"],
    },
  });
  await release("publish");
  await writeFile(
    path.join(root, "images.json.metadata.json"),
    JSON.stringify({
      api: { "containerimage.digest": imageId },
      web: { "containerimage.digest": imageId },
    }),
  );
  await release("sign");
  const identity =
    "https://github.com/swizzletech/swizzle/.github/workflows/images.yml@refs/tags/v1.0.3";
  expect((await calls()).filter((call) => !call.startsWith("compose "))).toEqual([
    "buildx bake -f images.json --push --metadata-file images.json.metadata.json",
    `cosign sign --yes registry.invalid/swizzle-api@${imageId}`,
    `cosign verify --certificate-identity ${identity} --certificate-oidc-issuer https://token.actions.githubusercontent.com registry.invalid/swizzle-api@${imageId}`,
    `cosign sign --yes registry.invalid/swizzle-web@${imageId}`,
    `cosign verify --certificate-identity ${identity} --certificate-oidc-issuer https://token.actions.githubusercontent.com registry.invalid/swizzle-web@${imageId}`,
  ]);
});

it("uses the Compose build context and Dockerfile for both a source build and a release plan", async () => {
  const { root, source, configure, calls, release } = await fixture();
  const context = path.join(root, "dashboard");
  await mkdir(context);
  await writeFile(path.join(context, "Containerfile"), "FROM scratch AS custom-web\n");
  await configure({
    context,
    dockerfile: "Containerfile",
    target: "custom-web",
    args: { VITE_API_BASE_URL: "/alternate-api", VERSION: "release$${suffix}" },
  });
  prepareImages(source, path.join(root, "prepared", "compose.json"));
  const build = (await calls()).find((call) => call.startsWith("buildx build "));
  expect(build).toContain(`--file ${context}/Containerfile --target custom-web`);
  expect(build).toContain(
    `--build-arg VITE_API_BASE_URL=/alternate-api --build-arg VERSION=release\${suffix} ${context}`,
  );

  await release("plan");
  const plan = JSON.parse(await readFile(path.join(root, "images.json"), "utf8"));
  expect(plan.target.web).toMatchObject({
    context: "dashboard",
    dockerfile: "Containerfile",
    target: "custom-web",
    args: { VITE_API_BASE_URL: "/api", VERSION: "release$${suffix}" },
  });
});

it("names unsupported Compose build fields before preparing or publishing images", async () => {
  const { root, source, configure, calls, release } = await fixture();
  await configure({ additional_contexts: { shared: "./shared" } });

  expect(() => prepareImages(source, path.join(root, "prepared", "compose.json"))).toThrow(
    "Unsupported Compose build field web.build.additional_contexts.",
  );
  await expect(release("plan")).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "Unsupported Compose build field web.build.additional_contexts.",
    ),
  });
  expect((await calls()).map((call) => call.split(" ", 1)[0])).toEqual(["compose", "compose"]);
});

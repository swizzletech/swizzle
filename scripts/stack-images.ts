import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface StackSource {
  readonly root: string;
  readonly envFile: string;
  readonly version?: string;
}

interface Build {
  readonly context: string;
  readonly dockerfile: string;
  readonly target: string;
  readonly args: Record<string, string>;
}
interface Service extends Record<string, unknown> {
  image?: string;
  build?: Build;
  environment?: Record<string, string>;
}
interface Compose extends Record<string, unknown> {
  name: string;
  services: Record<string, Service>;
}
export interface PreparedStack {
  readonly file: string;
  readonly images: Readonly<Record<string, string>>;
}
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/u;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every((item) => typeof item === "string");
}
export function capture(command: string, args: readonly string[], cwd = process.cwd()): string {
  return execFileSync(command, args, {
    cwd,
    shell: false,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function run(command: string, args: readonly string[], cwd = process.cwd()): void {
  execFileSync(command, args, { cwd, shell: false, stdio: "inherit" });
}
export function composeArgs(source: StackSource): string[] {
  return [
    "compose",
    "--env-file",
    path.resolve(source.envFile),
    "-f",
    path.join(source.root, "infra/docker/compose.yml"),
    "--profile",
    "stack",
    "--profile",
    "tools",
  ];
}
export function readCompose(source: StackSource): Compose {
  const value: unknown = JSON.parse(
    capture("docker", [...composeArgs(source), "config", "--format", "json"]),
  );
  if (!object(value) || typeof value.name !== "string" || !object(value.services)) {
    throw new Error("Docker Compose returned an invalid stack configuration.");
  }
  const services: Record<string, Service> = {};
  for (const [name, raw] of Object.entries(value.services)) {
    if (
      !object(raw) ||
      (raw.image !== undefined && typeof raw.image !== "string") ||
      (raw.environment !== undefined && !strings(raw.environment))
    ) {
      throw new Error(`Invalid Compose service ${name}.`);
    }
    const service: Service = { ...raw };
    if (typeof raw.image === "string") service.image = raw.image;
    if (strings(raw.environment)) service.environment = raw.environment;
    if (raw.build !== undefined) {
      const build = raw.build;
      if (!object(build)) throw new Error(`Invalid Compose build for ${name}.`);
      for (const key of Object.keys(build)) {
        if (!["context", "dockerfile", "target", "args"].includes(key)) {
          throw new Error(`Unsupported Compose build field ${name}.build.${key}.`);
        }
      }
      if (
        typeof build.context !== "string" ||
        typeof build.dockerfile !== "string" ||
        typeof build.target !== "string" ||
        (build.args !== undefined && !strings(build.args))
      ) {
        throw new Error(`Invalid Compose build for ${name}.`);
      }
      service.build = {
        context: build.context,
        dockerfile: build.dockerfile,
        target: build.target,
        args: build.args ?? {},
      };
    }
    services[name] = service;
  }
  return { ...value, name: value.name, services };
}

interface ServiceBuild {
  readonly name: string;
  readonly service: Service;
  readonly build: Build;
}

export function composeBuilds(config: Compose, root: string): ServiceBuild[] {
  const decodeComposeValue = (value: string) => value.replaceAll("$$", "$");
  return Object.entries(config.services).flatMap(([name, service]) => {
    const build = service.build;
    return build === undefined
      ? []
      : [
          {
            name,
            service,
            build: {
              context: path.resolve(root, decodeComposeValue(build.context)),
              dockerfile: decodeComposeValue(build.dockerfile),
              target: decodeComposeValue(build.target),
              args: Object.fromEntries(
                Object.entries(build.args).map(([key, value]) => [key, decodeComposeValue(value)]),
              ),
            },
          },
        ];
  });
}

export function releaseVersion(source: StackSource): string | undefined {
  if (source.version !== undefined) {
    if (!RELEASE_TAG.test(`v${source.version}`)) throw new Error("Invalid release version.");
    return source.version;
  }
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(source.root, "package.json"), "utf8"),
  );
  if (!object(manifest) || typeof manifest.version !== "string")
    throw new Error("No package version.");
  if (capture("git", ["status", "--porcelain", "--untracked-files=no"], source.root) !== "")
    return undefined;
  const tags = [
    ...capture("git", ["tag", "--points-at", "HEAD"], source.root).split("\n"),
    ...capture(
      "git",
      [
        "for-each-ref",
        "--points-at",
        "HEAD",
        "--format=%(refname:strip=3)",
        "refs/swizzle/releases",
      ],
      source.root,
    ).split("\n"),
  ];
  return tags.includes(`v${manifest.version}`) && RELEASE_TAG.test(`v${manifest.version}`)
    ? manifest.version
    : undefined;
}
export function registryImage(service: string, version: string): string {
  return `${process.env.SWIZZLE_IMAGE_REGISTRY ?? "ghcr.io/swizzletech"}/swizzle-${service}:${version}`;
}

function checkDisk(build: boolean): void {
  const root = capture("docker", ["info", "--format", "{{.DockerRootDir}}"]);
  let free: number;
  try {
    const disk = statfsSync(root);
    free = disk.bavail * disk.bsize;
  } catch {
    throw new Error(
      `Cannot check free disk space at Docker's data directory ${root}. Run on the Docker host with access to that path.`,
    );
  }
  const gib = build ? 12 : 5;
  if (free < gib * 1024 ** 3)
    throw new Error(
      `Need at least ${gib} GiB free at ${root} for ${build ? "source builds" : "release images"} and backup. Free disk space before retrying.`,
    );
}
export function preflight(source: StackSource): void {
  for (const [command, args] of [
    ["git", ["--version"]],
    ["just", ["--version"]],
    ["mise", ["--version"]],
    ["docker", ["compose", "version"]],
    ["docker", ["buildx", "version"]],
  ] as const) {
    try {
      capture(command, args, source.root);
    } catch {
      throw new Error(
        `Missing or unusable ${command === "docker" ? `docker ${args[0]}` : command}. Install it and put it on PATH before retrying. For mise, add its install directory, usually $HOME/.local/bin; mise exec adds pinned tools but does not add mise itself.`,
      );
    }
  }
  for (const command of ["bash", "tar", "cp", "mkdir", "dirname", "basename", "mktemp", "rm"]) {
    const found = (process.env.PATH ?? "").split(path.delimiter).some((directory) => {
      const file = path.resolve(source.root, directory, command);
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
    if (!found) {
      throw new Error(`Missing ${command}. Put it on PATH before retrying.`);
    }
  }
  try {
    capture("mise", ["exec", "--", "node", "--version"], source.root);
  } catch {
    throw new Error(
      "The pinned Node toolchain is unavailable. Run mise trust && mise install, then retry.",
    );
  }
}

export function writeCompose(config: Compose, file: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
}

type ImagePreparation = ServiceBuild &
  (
    | { readonly kind: "build"; readonly tag: string }
    | { readonly kind: "pull"; readonly image: string }
  );

function planImages(
  builds: readonly ServiceBuild[],
  project: string,
  suffix: string,
  version: string | undefined,
): ImagePreparation[] {
  return builds.map((entry) => {
    const apiUrl = entry.build.args.VITE_API_BASE_URL;
    return version === undefined ||
      (entry.name === "web" && apiUrl !== undefined && apiUrl !== "/api")
      ? { ...entry, kind: "build", tag: `${project}-${entry.name}:${suffix}` }
      : { ...entry, kind: "pull", image: registryImage(entry.name, version) };
  });
}

function pullReleaseImages(
  plan: readonly ImagePreparation[],
  version: string,
): "pulled" | "absent" {
  const pulls = plan.filter((entry) => entry.kind === "pull");
  for (const [index, { image }] of pulls.entries()) {
    process.stdout.write(`Pulling ${image} before service shutdown.\n`);
    try {
      process.stdout.write(`${capture("docker", ["pull", image])}\n`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (index !== 0 || !/manifest unknown|not found|name unknown/iu.test(detail)) {
        throw new Error(
          `Cannot pull ${image}. Services are unchanged. Check registry access and publication.\n${detail}`,
        );
      }
      for (const { image: reference } of pulls.slice(1)) {
        try {
          capture("docker", ["pull", reference]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (/manifest unknown|not found|name unknown/iu.test(reason)) continue;
          throw new Error(`Cannot check ${reference}. Services are unchanged.\n${reason}`);
        }
        throw new Error(
          `Release ${version} has an incomplete image publication. Services are unchanged. Wait for the release image workflow to finish.`,
        );
      }
      process.stdout.write(`Release ${version} has no published images; building sequentially.\n`);
      return "absent";
    }
  }
  return "pulled";
}

function serialDockerfile(build: Build, directory: string, files: Map<string, string>): string {
  const original = path.resolve(build.context, build.dockerfile);
  const cached = files.get(original);
  if (cached !== undefined) return cached;

  const text = readFileSync(original, "utf8");
  const serial = text.replace(
    /^RUN pnpm exec turbo run build(?: --concurrency=\d+)?$/mu,
    "RUN pnpm exec turbo run build --concurrency=1",
  );
  const file = serial === text ? original : path.join(directory, `Dockerfile.serial-${files.size}`);
  if (serial !== text) writeFileSync(file, serial, { mode: 0o600 });
  files.set(original, file);
  return file;
}

function buildImage(
  build: Build,
  options: {
    readonly project: string;
    readonly service: string;
    readonly imageFile: string;
    readonly tag?: string;
  },
): string {
  run("docker", [
    "buildx",
    "build",
    "--load",
    "--iidfile",
    options.imageFile,
    "--file",
    build.dockerfile,
    "--target",
    build.target,
    ...(options.tag === undefined ? [] : ["--tag", options.tag]),
    "--label",
    `com.docker.compose.project=${options.project}`,
    "--label",
    `com.docker.compose.service=${options.service}`,
    ...Object.entries(build.args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]),
    build.context,
  ]);
  return readFileSync(options.imageFile, "utf8").trim();
}

function executeImagePlan(
  project: string,
  directory: string,
  plan: readonly ImagePreparation[],
): Record<string, string> {
  const dockerfiles = new Map<string, string>();
  if (plan.some((entry) => entry.kind === "build")) {
    checkDisk(true);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return Object.fromEntries(
    plan.map((entry) => {
      const { name, service } = entry;
      let reference: string;
      if (entry.kind === "pull") {
        reference = entry.image;
      } else {
        const dockerfile = serialDockerfile(entry.build, directory, dockerfiles);
        process.stdout.write(`Building ${name} sequentially before service shutdown.\n`);
        reference = buildImage(
          { ...entry.build, dockerfile },
          {
            project,
            service: name,
            imageFile: path.join(directory, `${name}.iid`),
            tag: entry.tag,
          },
        );
      }
      const id = capture("docker", ["image", "inspect", "--format", "{{.Id}}", reference]);
      service.image = id;
      delete service.build;
      service.pull_policy = "never";
      return [name, id];
    }),
  );
}

export function prepareImages(
  source: StackSource,
  output: string,
  options: { readonly services?: readonly string[]; readonly tag?: "local" } = {},
): PreparedStack {
  const config = readCompose(source);
  const builds = composeBuilds(config, source.root);
  const packages = (
    builds.find(({ name }) => name === "runner-base")?.build.args.SWIZZLE_RUNNER_APT_PACKAGES ?? ""
  )
    .trim()
    .split(/ +/u)
    .filter(Boolean);
  for (const entry of packages) {
    if (!/^[a-z0-9][a-z0-9+.-]+$/u.test(entry))
      throw new Error(
        `Invalid SWIZZLE_RUNNER_APT_PACKAGES entry ${JSON.stringify(entry)}. Use space-separated Debian package names.`,
      );
  }
  const selected = builds.filter(
    ({ name }) => options.services === undefined || options.services.includes(name),
  );
  const version = releaseVersion(source);
  const publishesImages = existsSync(path.join(source.root, ".github/workflows/images.yml"));
  const directory = path.dirname(output);
  const suffix =
    options.tag ??
    `${path.basename(directory)}-${path.basename(output, ".json")}`.replaceAll(
      /[^a-zA-Z0-9_.-]/gu,
      "-",
    );
  const plan = planImages(selected, config.name, suffix, publishesImages ? version : undefined);
  checkDisk(plan.some((entry) => entry.kind === "build"));
  const finalPlan =
    version !== undefined && pullReleaseImages(plan, version) === "absent"
      ? planImages(selected, config.name, suffix, undefined)
      : plan;
  const images = executeImagePlan(config.name, directory, finalPlan);
  if (packages.length > 0 && options.services === undefined) {
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const suffix =
      options.tag ?? path.basename(path.dirname(output)).replaceAll(/[^a-zA-Z0-9_.-]/gu, "-");
    const stockTags: string[] = [];
    const tagStockImage = (name: string): string => {
      const image = images[name];
      if (image === undefined) throw new Error(`No prepared ${name} image for runner packages.`);
      const tag = `${config.name}-${name}:stock-${randomUUID()}`;
      run("docker", ["tag", image, tag]);
      stockTags.push(tag);
      return tag;
    };
    try {
      const runnerBase = tagStockImage("runner-base");
      const workerBase = tagStockImage("worker");
      for (const [name, target] of [
        ["runner-base", "runner"],
        ["worker", "worker"],
      ] as const) {
        const imageFile = path.join(path.dirname(output), `${name}-packages.iid`);
        process.stdout.write(`Adding runner packages to ${name}: ${packages.join(" ")}.\n`);
        const image = buildImage(
          {
            context: source.root,
            dockerfile: path.join(source.root, "infra/docker/Dockerfile.runner"),
            target,
            args: {
              RUNNER_BASE: runnerBase,
              WORKER_BASE: workerBase,
              SWIZZLE_RUNNER_APT_PACKAGES: packages.join(" "),
            },
          },
          { project: config.name, service: name, imageFile },
        );
        run("docker", ["tag", image, `${config.name}-${name}:${suffix}-packages`]);
        const service = config.services[name];
        if (service === undefined) throw new Error(`No ${name} service.`);
        service.image = image;
        images[name] = image;
      }
    } finally {
      for (const tag of stockTags) {
        try {
          capture("docker", ["image", "rm", tag]);
        } catch (error) {
          process.stderr.write(
            `Could not remove temporary stock image ${tag}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
  }
  if (options.services === undefined) {
    const worker = config.services.worker;
    const base = config.services["runner-base"];
    if (worker?.environment !== undefined && base?.image !== undefined)
      worker.environment.SWIZZLE_RUNNER_BASE_IMAGE = base.image;
    const dependencies = Object.values(config.services).filter(
      (service) => service.build === undefined && service.pull_policy !== "never",
    );
    for (const service of dependencies) {
      if (service.image !== undefined) {
        try {
          capture("docker", ["image", "inspect", service.image]);
        } catch {
          run("docker", ["pull", service.image]);
        }
        service.image = capture("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          service.image,
        ]);
        service.pull_policy = "never";
      }
    }
  }
  writeCompose(config, output);
  return {
    file: output,
    images,
  };
}

// Shared by install, backup and upgrade. Preparation never stops a service.
import { execFileSync } from "node:child_process";
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
  /** Supplied for an archived release, which has no Git metadata of its own. */
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
  /** Resolved Compose file with local image references and no build instructions. */
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
      if (
        !object(build) ||
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

/** A conservative reserve covers unpacked images and leaves room for the backup. */
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
  // Resolve the target's pinned tools now, including first-time downloads, before downtime.
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
  // Compose's config output already escapes dollars for another Compose read.
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
}

/** Pull a complete release or build one service at a time, then forbid builds at switch time. */
export function prepareImages(
  source: StackSource,
  output: string,
  options: { readonly services?: readonly string[]; readonly tag?: "local" } = {},
): PreparedStack {
  const config = readCompose(source);
  const builds = Object.entries(config.services).filter(
    ([name, service]) =>
      service.build !== undefined &&
      (options.services === undefined || options.services.includes(name)),
  );
  const version = releaseVersion(source);
  const publishesImages = existsSync(path.join(source.root, ".github/workflows/images.yml"));
  const fromSource = new Set(
    builds
      .filter(
        ([name, service]) =>
          version === undefined ||
          !publishesImages ||
          (name === "web" &&
            service.build?.args.VITE_API_BASE_URL !== undefined &&
            service.build.args.VITE_API_BASE_URL !== "/api"),
      )
      .map(([name]) => name),
  );
  checkDisk(fromSource.size > 0);
  if (version !== undefined) {
    for (const [index, [name]] of builds.filter(([name]) => !fromSource.has(name)).entries()) {
      const image = registryImage(name, version);
      process.stdout.write(`Pulling ${image} before service shutdown.\n`);
      try {
        process.stdout.write(`${capture("docker", ["pull", image])}\n`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // Old releases without the publishing workflow build directly. A published release's
        // authentication, network, or partial-publication failures must leave services running.
        if (index !== 0 || !/manifest unknown|not found|name unknown/iu.test(detail)) {
          throw new Error(
            `Cannot pull ${image}. Services are unchanged. Check registry access and publication.\n${detail}`,
          );
        }
        // A first missing package may be a partial publication. Build only when the whole
        // release is absent; otherwise leave the server running until publication is fixed.
        for (const [other] of builds.filter(([service]) => !fromSource.has(service)).slice(1)) {
          const reference = registryImage(other, version);
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
        process.stdout.write(
          `Release ${version} has no published images; building sequentially.\n`,
        );
        for (const [service] of builds) fromSource.add(service);
        break;
      }
    }
  }
  if (fromSource.size > 0) {
    checkDisk(true);
    // Upgrade preparations keep separate tags so installed images survive for rollback.
    const suffix =
      options.tag ??
      `${path.basename(path.dirname(output))}-${path.basename(output, ".json")}`.replaceAll(
        /[^a-zA-Z0-9_.-]/gu,
        "-",
      );
    for (const [name, service] of builds) {
      if (fromSource.has(name)) service.image = `${config.name}-${name}:${suffix}`;
    }
    // Earlier 1.x Dockerfiles compile every workspace in parallel and have no concurrency arg.
    // Stage their build recipe with the same cap, without editing the installed checkout.
    const dockerfiles = new Map<string, string>();
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    for (const [name, service] of builds.filter(([name]) => fromSource.has(name))) {
      const build = service.build;
      if (build === undefined) throw new Error(`No source build for ${name}.`);
      const original = path.resolve(
        source.root,
        build.context.replaceAll("$$", "$"),
        build.dockerfile.replaceAll("$$", "$"),
      );
      let file = dockerfiles.get(original);
      if (file === undefined) {
        const text = readFileSync(original, "utf8");
        const serial = text.replace(
          /^RUN pnpm exec turbo run build(?: --concurrency=\d+)?$/mu,
          "RUN pnpm exec turbo run build --concurrency=1",
        );
        file = original;
        if (serial !== text) {
          file = path.join(path.dirname(output), `Dockerfile.serial-${dockerfiles.size}`);
          writeFileSync(file, serial, { mode: 0o600 });
        }
        dockerfiles.set(original, file);
      }
      service.build = { ...build, dockerfile: file };
    }
    for (const [name, service] of builds.filter(([name]) => fromSource.has(name))) {
      process.stdout.write(`Building ${name} sequentially before service shutdown.\n`);
      const build = service.build;
      if (build === undefined || service.image === undefined)
        throw new Error(`No source image for ${name}.`);
      const imageFile = path.join(path.dirname(output), `${name}.iid`);
      run("docker", [
        "buildx",
        "build",
        "--load",
        "--iidfile",
        imageFile,
        "--file",
        build.dockerfile,
        "--target",
        build.target,
        "--tag",
        service.image,
        "--label",
        `com.docker.compose.project=${config.name}`,
        "--label",
        `com.docker.compose.service=${name}`,
        ...Object.entries(build.args).flatMap(([key, value]) => [
          "--build-arg",
          `${key}=${value.replaceAll("$$", "$")}`,
        ]),
        build.context.replaceAll("$$", "$"),
      ]);
      // The tag is shared by development builds; the ID file belongs to this preparation.
      service.image = readFileSync(imageFile, "utf8").trim();
    }
  }
  const images: Record<string, string> = {};
  for (const [name, service] of builds) {
    if (!fromSource.has(name) && version !== undefined)
      service.image = registryImage(name, version);
    if (service.image === undefined) throw new Error(`No prepared image for ${name}.`);
    // Pin the image ID so a tag moved during backup cannot change what starts.
    service.image = capture("docker", ["image", "inspect", "--format", "{{.Id}}", service.image]);
    images[name] = service.image;
    delete service.build;
    service.pull_policy = "never";
  }
  if (options.services === undefined) {
    const worker = config.services.worker;
    const base = config.services["runner-base"];
    if (worker?.environment !== undefined && base?.image !== undefined)
      worker.environment.SWIZZLE_RUNNER_BASE_IMAGE = base.image;
    // Dependency images also arrive before any writer stops.
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

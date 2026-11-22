import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  capture,
  composeBuilds,
  RELEASE_TAG,
  readCompose,
  registryImage,
  run,
} from "./stack-images.ts";

function bakeLiteral(value: string): string {
  return value.replaceAll(/\$\{|%\{/gu, (marker) => marker.charAt(0) + marker);
}

const [command, version, file] = process.argv.slice(2);
try {
  if (
    !["plan", "publish", "sign"].includes(command ?? "") ||
    version === undefined ||
    !RELEASE_TAG.test(`v${version}`) ||
    file === undefined ||
    process.argv.length !== 5
  ) {
    throw new Error("Usage: just image-plan|image-publish|image-sign <X.Y.Z> <file>");
  }
  const root = process.cwd();
  const services = composeBuilds(readCompose({ root, envFile: path.resolve(".env") }), root);
  if (command === "plan") {
    const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      manifest.version !== version
    )
      throw new Error("The release tag and package.json version must match.");
    const revision = capture("git", ["rev-parse", "HEAD"]);
    const target = Object.fromEntries(
      services.map(({ name, build }) => [
        name,
        {
          context: bakeLiteral(path.relative(root, build.context) || "."),
          dockerfile: bakeLiteral(build.dockerfile),
          target: bakeLiteral(build.target),
          args: {
            ...Object.fromEntries(
              Object.entries(build.args).map(([name, value]) => [name, bakeLiteral(value)]),
            ),
            VITE_API_BASE_URL: "/api",
          },
          tags: [registryImage(name, version)],
          platforms: ["linux/amd64", "linux/arm64"],
          attest: ["type=provenance,mode=max"],
          labels: {
            "org.opencontainers.image.source": "https://github.com/swizzletech/swizzle",
            "org.opencontainers.image.version": version,
            "org.opencontainers.image.revision": revision,
          },
        },
      ]),
    );
    writeFileSync(
      file,
      JSON.stringify({ group: { default: { targets: Object.keys(target) } }, target }, null, 2),
    );
  } else if (command === "publish") {
    run("docker", [
      "buildx",
      "bake",
      "-f",
      file,
      "--push",
      "--metadata-file",
      `${file}.metadata.json`,
    ]);
  } else {
    const metadata: unknown = JSON.parse(readFileSync(`${file}.metadata.json`, "utf8"));
    if (metadata === null || typeof metadata !== "object")
      throw new Error("Invalid bake metadata.");
    for (const { name } of services) {
      if (!(name in metadata)) throw new Error(`No published digest for ${name}.`);
      const result: unknown = Reflect.get(metadata, name);
      const digest: unknown =
        result !== null && typeof result === "object"
          ? Reflect.get(result, "containerimage.digest")
          : undefined;
      if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))
        throw new Error(`Invalid digest for ${name}.`);
      const image = `${registryImage(name, version).replace(/:[^:]+$/u, "")}@${digest}`;
      run("cosign", ["sign", "--yes", image]);
      run("cosign", [
        "verify",
        "--certificate-identity",
        `https://github.com/swizzletech/swizzle/.github/workflows/images.yml@refs/tags/v${version}`,
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        image,
      ]);
    }
  }
} catch (error) {
  process.stderr.write(
    `Release images: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

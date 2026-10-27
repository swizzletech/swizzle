import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import manifest from "./package.json" with { type: "json" };

const cli = new URL("./", import.meta.url);
await rm(new URL("dist/", cli), { recursive: true, force: true });
const built = await build({
  absWorkingDir: fileURLToPath(cli),
  entryPoints: ["src/bin.ts", "src/main.ts"],
  outdir: fileURLToPath(new URL("dist/", cli)),
  bundle: true,
  metafile: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22.18",
  conditions: ["swizzle-source"],
  external: ["esbuild"],
  banner: {
    js: 'import { createRequire as __cliCreateRequire } from "node:module"; const require = __cliCreateRequire(import.meta.url);',
  },
  legalComments: "linked",
});
await chmod(new URL("dist/bin.js", cli), 0o755);

const dependencyRoots = new Set<string>();
for (const input of Object.keys(built.metafile.inputs)) {
  const marker = "/node_modules/";
  const index = input.lastIndexOf(marker);
  if (index === -1) continue;
  const parts = input.slice(index + marker.length).split("/");
  const packageName = parts.slice(0, parts[0]?.startsWith("@") ? 2 : 1).join("/");
  dependencyRoots.add(
    path.resolve(fileURLToPath(cli), input.slice(0, index + marker.length), packageName),
  );
}
const notices: string[] = [];
for (const root of [...dependencyRoots].sort()) {
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const file of (await readdir(root)).sort()) {
    if (!/^(licen[cs]e|copying|notice)([.-]|$)/iu.test(file)) continue;
    notices.push(
      `${metadata.name}@${metadata.version}: ${file}\n${await readFile(path.join(root, file), "utf8")}`,
    );
  }
}
await writeFile(new URL("dist/THIRD-PARTY-NOTICES.txt", cli), notices.join("\n\n"));

// npm receives only the executable, its assets and its one native runtime dependency.
const output = new URL("build/npm/", cli);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("dist/", cli), new URL("dist/", output), { recursive: true });
await cp(new URL("assets/", cli), new URL("assets/", output), { recursive: true });
await cp(new URL("../../LICENSE", import.meta.url), new URL("LICENSE", output));
await writeFile(
  new URL("package.json", output),
  `${JSON.stringify(
    {
      name: manifest.swizzlePackageName,
      version: manifest.version,
      description: "Build, deploy and operate code automations on a remote Swizzle instance.",
      license: manifest.license,
      repository: manifest.repository,
      homepage: manifest.homepage,
      bugs: manifest.bugs,
      type: manifest.type,
      bin: manifest.bin,
      engines: { node: ">=22.18.0" },
      files: ["dist", "assets", "LICENSE"],
      dependencies: { esbuild: manifest.dependencies.esbuild },
    },
    null,
    2,
  )}\n`,
);

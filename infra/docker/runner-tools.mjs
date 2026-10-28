// Prints, as JSON, every executable a run in this image finds on its PATH, with the version of the
// Debian or npm package that ships it, or of Node itself; null when neither says. The runner-base
// build writes it to /etc/swizzle/runner-tools.json, and the worker image copies that file and
// reports its binaries, which `requirements.binaries` is checked against (readRunnerTools in
// packages/runtime). Package versions need no `--version` flag, which not every tool knows.
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

const executables = new Map();
for (const directory of (process.env.PATH ?? "").split(":")) {
  if (!existsSync(directory)) continue;
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    // The first directory on PATH wins, as it does for a shell.
    if (executables.has(name)) continue;
    // A directory is searchable with X_OK too, but cannot run.
    try {
      accessSync(file, constants.X_OK);
      if (statSync(file).isFile()) executables.set(name, { file, real: realpathSync(file) });
    } catch {}
  }
}

// dpkg-query -S exits 1 when a path has no package and still prints the owners of the others.
const paths = new Set([...executables.values()].flatMap(({ file, real }) => [file, real]));
const owners = new Map();
for (const line of spawnSync("dpkg-query", ["-S", ...paths], { encoding: "utf8" }).stdout.split(
  "\n",
)) {
  const match = /^(.+?): (\/.+)$/u.exec(line);
  if (match) owners.set(match[2], match[1].split(", ")[0]);
}
const packages = new Map(
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query's own format fields.
  spawnSync("dpkg-query", ["-W", "-f", "${binary:Package} ${Version}\\n"], { encoding: "utf8" })
    .stdout.split("\n")
    .map((line) => line.split(" ")),
);
// 1:2.47.3-0+deb13u1 is git 2.47.3: the upstream version, without the epoch and Debian revision.
const upstream = (version) => version.replace(/^\d+:/u, "").replace(/-[^-]*$/u, "");

function npmVersion(real) {
  for (let directory = path.dirname(real); directory.includes("node_modules"); ) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf8")).version ?? null;
    directory = path.dirname(directory);
  }
  return null;
}

function version({ file, real }) {
  const owner = owners.get(file) ?? owners.get(real);
  const packaged = owner && (packages.get(owner) ?? packages.get(owner.split(":")[0]));
  if (packaged) return upstream(packaged);
  if (real === process.execPath) return process.versions.node;
  return npmVersion(real);
}

const binaries = [...executables]
  .map(([name, executable]) => ({ name, version: version(executable) }))
  .sort((left, right) => left.name.localeCompare(right.name));
process.stdout.write(`${JSON.stringify({ binaries })}\n`);

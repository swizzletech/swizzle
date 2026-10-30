import { execFile } from "node:child_process";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const script = path.resolve("infra/docker/runner-tools.mjs");

it("records the first executable file on PATH and passes over a directory of the same name", async () => {
  const root = await temporaryDirectory("swizzle-runner-tools-");
  const [first, second, pkg] = ["first", "second", "node_modules/tool"].map((directory) =>
    path.join(root, directory),
  );
  for (const directory of [first, second, pkg, path.join(first ?? "", "tool")])
    await mkdir(directory ?? "", { recursive: true });
  await writeFile(path.join(pkg ?? "", "package.json"), '{"name":"tool","version":"1.2.3"}');
  await writeFile(path.join(pkg ?? "", "cli.js"), "#!/bin/sh\n");
  await chmod(path.join(pkg ?? "", "cli.js"), 0o755);
  await symlink(path.join(pkg ?? "", "cli.js"), path.join(second ?? "", "tool"));
  // The runner image's dpkg-query; here it owns nothing.
  await writeFile(path.join(second ?? "", "dpkg-query"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(second ?? "", "dpkg-query"), 0o755);

  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    env: { PATH: `${first}:${second}` },
  });

  expect(JSON.parse(stdout)).toEqual({
    languages: [],
    dependencyPackaging: { node: false, python: false },
    binaries: [
      { name: "dpkg-query", version: null },
      { name: "tool", version: "1.2.3" },
    ],
  });
});

it("records runtime versions and packaging probes rather than assuming executable names are enough", async () => {
  const bin = await temporaryDirectory("swizzle-runner-probes-");
  for (const [name, source] of Object.entries({
    "dpkg-query": "#!/bin/sh\nexit 1\n",
    python3:
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.13.5"; exit 0; fi\nif [ "$2" = "pip" ]; then echo "pip 25.1"; exit 0; fi\nexit 1',
    npm: "#!/bin/sh\nexit 1\n",
    pip: "#!/bin/sh\nexit 0\n",
  }))
    await writeFile(path.join(bin, name), source, { mode: 0o755 });
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env: { PATH: bin } });
  expect(JSON.parse(stdout)).toMatchObject({
    languages: [{ name: "python", version: "3.13.5" }],
    // The venv import failed, and npm could not run, even though pip and npm are on PATH.
    dependencyPackaging: { node: false, python: false },
  });
});

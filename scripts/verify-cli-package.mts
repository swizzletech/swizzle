/** Prove an npm tarball as an author installs it. Also runs on a laptop without the checkout. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tarball = path.resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: verify-cli-package.mts <tarball> [https-instance-api-url]");
const remote = process.argv[3];
const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-package-"));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  SWIZZLE_CONFIG_HOME: path.join(directory, "config"),
  npm_config_cache: path.join(directory, "npm-cache"),
};
delete env.SWIZZLE_PROFILE;
delete env.SWIZZLE_ENVIRONMENT;

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: directory, env, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}
function cli(...args: string[]) {
  const output = run(process.execPath, [
    path.join(directory, "node_modules/.bin/swizzle"),
    ...args,
    "--json",
  ]);
  console.log(`swizzle ${args.join(" ")}\n${output}`);
  return JSON.parse(output);
}
try {
  run("npm", ["install", "--no-audit", "--no-fund", tarball]);
  console.log(`Installed tarball in empty directory: ${directory}`);
  console.log(`Runtime: ${process.platform} ${process.arch}, Node ${process.version}`);
  console.log(run("npm", ["ls", "--omit=dev", "--depth=1"]));
  // Recipes supply config; a minimal entrypoint completes each folder without calling outside APIs.
  const packageRoot = path.dirname(
    path.dirname(await realpath(path.join(directory, "node_modules/.bin/swizzle"))),
  );
  const recipes = await readFile(
    path.join(packageRoot, "assets/skills/swizzle-builder/references/recipes.md"),
    "utf8",
  );
  const configs = [...recipes.matchAll(/```yaml\n([\s\S]*?)\n```/gu)];
  assert(configs.length > 0, "The installed skill must contain recipe configurations");
  for (const [index, match] of configs.entries()) {
    const config = match[1];
    assert(config);
    const name = config.match(/^name: (.+)$/mu)?.[1] ?? `pipeline-fragment-${index}`;
    const entrypoint = config.match(/^entrypoint: (.+)$/mu)?.[1] ?? "main.py";
    const recipeDir = path.join(directory, `recipe-${index}`);
    await mkdir(recipeDir);
    await writeFile(
      path.join(recipeDir, "config.yaml"),
      `${/^name:/mu.test(config) ? "" : `name: ${name}\nversion: 1.0.0\n`}${config}\n`,
    );
    await writeFile(
      path.join(recipeDir, entrypoint),
      entrypoint.endsWith(".py") ? 'print("{}")\n' : 'console.log("{}");\n',
    );
    await writeFile(path.join(recipeDir, "requirements.txt"), "");
    assert.equal(cli("validate", recipeDir).valid, true);
    console.log(`PASS recipe ${index + 1}: ${name}`);
  }
  if (remote) {
    assert.equal(new URL(remote).protocol, "https:");
    assert(env.SWIZZLE_TOKEN, "SWIZZLE_TOKEN must authorize the remote instance");
    cli(
      "profile",
      "add",
      "remote",
      "--url",
      remote,
      "--token-env",
      "SWIZZLE_TOKEN",
      "--env",
      "staging",
    );
    cli("profile", "use", "remote");
  }
  cli("skill", "install", "--dir", "workspace");
  assert.match(
    await readFile(
      path.join(directory, "workspace/.agents/skills/swizzle-builder/SKILL.md"),
      "utf8",
    ),
    /name: swizzle-builder/u,
  );
  assert.equal(
    cli("skill", "install", "--dir", "workspace").skill.state,
    "already installed (no-op)",
  );
  for (const template of ["typescript", "python"]) {
    const name = `packed-${template}-${Date.now()}`;
    cli("init", name, "--template", template, "--pattern", "cron-indexer");
    assert.match(
      await readFile(
        path.join(directory, name, template === "python" ? "swizzle_sdk.py" : "swizzle-sdk.ts"),
        "utf8",
      ),
      /run_automation|runAutomation/u,
    );
    assert.equal(cli("validate", name, "--bundle").valid, true);
    assert.equal(cli("run", name).run.status, "succeeded");
    if (remote) {
      cli("apply", name);
      const triggered = cli(
        "trigger",
        name,
        "--exact",
        "--payload-file",
        `${name}/sample-payload.json`,
      );
      const runId = triggered.run.id;
      assert.equal(typeof runId, "string");
      let status = "queued";
      for (let attempt = 0; attempt < 60; attempt++) {
        const detail = cli("runs", "inspect", runId);
        status = detail.run.status;
        if (["succeeded", "failed", "dead-lettered", "cancelled"].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(status, "succeeded");
    }
  }
  console.log(
    "PASS: packaged SDK scaffolds, validation, local runs and skill installation" +
      (remote ? ", HTTPS deployments and worker runs" : ""),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
  console.log(`Removed temporary directory: ${directory}`);
}

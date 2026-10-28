import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { testPlatform } from "../../../test/platform.js";
import { temporaryDirectory } from "../../../test/support.js";
import {
  appRoot,
  buildTestServer,
  createBufferIO,
  createDashboardStub,
  OWNER_TOKEN,
  useCliTestEnvironment,
  withoutProfile,
} from "../test/cli-harness.js";
import { runCli } from "./main.js";

const exec = promisify(execFile);

useCliTestEnvironment();
beforeEach(withoutProfile);

describe("swizzle init", () => {
  it("scaffolds a python automation that validates and runs with the sample payload", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-init-");
    const targetDirectory = path.join(directory, "customer-intake");

    const exitCode = await runCli(["init", targetDirectory], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toContain("  template: python\n  pattern: webhook-basic\n");
    expect(io.stdoutText).toContain(`Run \`swizzle validate ${targetDirectory}\``);

    const createdFiles = await readdir(targetDirectory);
    expect(createdFiles.sort()).toEqual([
      "README.md",
      "check.py",
      "config.yaml",
      "flow.mermaid",
      "main.py",
      "sample-payload.json",
      "swizzle_sdk.py",
    ]);

    const validateIo = createBufferIO();
    const validateExitCode = await runCli(["validate", targetDirectory], validateIo);
    expect(validateExitCode).toBe(0);
    expect(validateIo.stdoutText).toContain("  samplePayload: sample-payload.json\n");

    const runIo = createBufferIO();
    const runExitCode = await runCli(["run", targetDirectory, "--json"], runIo);
    expect(runExitCode).toBe(0);
    const run = JSON.parse(runIo.stdoutText);
    expect(run.run).toMatchObject({
      status: "succeeded",
      payload: `${path.join(targetDirectory, "sample-payload.json")} (sample)`,
    });
    expect(run.result).toMatchObject({
      automation: "customer-intake",
      message: "Python scaffold executed successfully",
      payload: {
        event: "example.created",
      },
      // Nothing checked a signature on this unsigned sample: a local run is started by hand.
      signed_delivery: false,
      trigger_type: "manual",
    });

    // The check stub validates once api_check is active, and reports drift until it is written.
    const configPath = path.join(targetDirectory, "config.yaml");
    await writeFile(
      configPath,
      `${await readFile(configPath, "utf8")}api_check:\n  mode: active\n`,
    );
    expect(await runCli(["validate", targetDirectory], createBufferIO())).toBe(0);
    const checkIo = createBufferIO();
    expect(await runCli(["run", targetDirectory, "--check"], checkIo)).toBe(1);
    expect(checkIo.stdoutText).toContain("code: API_CHECK_DRIFT\n");
  });

  // A first-time author pastes these steps into a shell with a remote profile; each one must pass
  // before the next, so the signing secret has to exist before validate asks the instance for it.
  it("runs the webhook scaffold's README and init steps in order against a remote profile", async () => {
    const app = await buildTestServer({
      dashboard: createDashboardStub("unused"),
      platform: await testPlatform(),
    });
    // Closing the server also closes the platform it serves.
    onTestFinished(() => app.close());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await runCli(
      ["profile", "add", "owner", "--url", address, "--token", OWNER_TOKEN, "--default"],
      createBufferIO(),
    );
    const directory = await temporaryDirectory("swizzle-cli-init-steps-");
    const bin = path.join(directory, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "swizzle"),
      `#!/bin/sh\nexec "${process.execPath}" --conditions=swizzle-source --import "${import.meta.resolve("tsx")}" "${path.join(appRoot, "src/bin.ts")}" "$@"\n`,
      { mode: 0o755 },
    );
    // Asynchronous, so this process keeps serving the API the steps call. A failure's message
    // carries the trace and every answer, which all go to stderr.
    const shell = (script: string, cwd: string) =>
      exec("bash", ["-euo", "pipefail", "-xc", `exec 1>&2\n${script}`], {
        cwd,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });

    const readmeTarget = path.join(directory, "orders");
    expect(await runCli(["init", readmeTarget], createBufferIO())).toBe(0);
    const readme = await readFile(path.join(readmeTarget, "README.md"), "utf8");
    const workflow = /```bash\n([\s\S]*?)```/u.exec(readme)?.[1] ?? "";
    expect(workflow).toContain("swizzle apply .");
    await shell(workflow, readmeTarget);

    const helpTarget = path.join(directory, "invoices");
    const init = createBufferIO();
    expect(await runCli(["init", helpTarget, "--json"], init)).toBe(0);
    const help: string[] = JSON.parse(init.stdoutText).help;
    const steps = help.flatMap((line) => [...line.matchAll(/`([^`]+)`/gu)].map((m) => m[1]));
    expect(steps.at(-1)).toBe(`swizzle apply ${helpTarget}`);
    await shell(steps.join("\n"), directory);
  });

  it("scaffolds a node automation when requested", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-init-node-");
    const targetDirectory = path.join(directory, "webhook-normalizer");

    const exitCode = await runCli(["init", targetDirectory, "--template", "node"], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toContain("  template: node\n");

    const runIo = createBufferIO();
    const runExitCode = await runCli(["run", targetDirectory, "--json"], runIo);
    expect(runExitCode).toBe(0);
    expect(JSON.parse(runIo.stdoutText).result).toMatchObject({
      automation: "webhook-normalizer",
      message: "Node scaffold executed successfully",
      payload: {
        event: "example.created",
      },
    });
  });

  it("scaffolds a typescript automation with the vendored helper", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-init-typescript-");
    const targetDirectory = path.join(directory, "typed-transformer");

    const exitCode = await runCli(
      ["init", targetDirectory, "--template", "typescript", "--pattern", "webhook-transformer"],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toContain("  template: typescript\n  pattern: webhook-transformer\n");

    const validateIo = createBufferIO();
    const validateExitCode = await runCli(["validate", targetDirectory, "--json"], validateIo);
    expect(validateExitCode).toBe(0);
    expect(JSON.parse(validateIo.stdoutText)).toMatchObject({
      valid: true,
      automation: { entrypoint: "main.ts" },
    });

    const runIo = createBufferIO();
    const runExitCode = await runCli(["run", targetDirectory, "--json"], runIo);
    expect(runExitCode).toBe(0);
    expect(JSON.parse(runIo.stdoutText).result).toMatchObject({
      normalized: {
        event: "invoice.created",
      },
      status: "ok",
    });
  });

  it("installs the packaged swizzle-builder skill into a workspace", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-skill-");

    const exitCode = await runCli(["skill", "install", "--dir", directory], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toContain("  state: installed\n");
    const skillDirectory = path.join(directory, ".agents/skills/swizzle-builder");
    const packagedSkill = path.join(appRoot, "assets/skills/swizzle-builder");
    expect((await readdir(skillDirectory, { recursive: true })).sort()).toEqual(
      (await readdir(packagedSkill, { recursive: true })).sort(),
    );
    expect(await readFile(path.join(skillDirectory, "SKILL.md"), "utf8")).toBe(
      await readFile(path.join(packagedSkill, "SKILL.md"), "utf8"),
    );
    const claudeSkills = path.join(directory, ".claude/skills");
    expect((await lstat(claudeSkills)).isSymbolicLink()).toBe(true);
    expect(await readlink(claudeSkills)).toBe("../.agents/skills");
  });

  it("reinstalls the same skill as a no-op and refuses to replace a changed one without force", async () => {
    const directory = await temporaryDirectory("swizzle-cli-skill-existing-");
    const install = async (...flags: string[]) => {
      const io = createBufferIO();
      const exitCode = await runCli(
        ["skill", "install", "--dir", directory, ...flags, "--json"],
        io,
      );
      return { exitCode, output: JSON.parse(io.stdoutText) };
    };

    expect((await install()).exitCode).toBe(0);
    expect(await install()).toMatchObject({
      exitCode: 0,
      output: { skill: { state: "already installed (no-op)" } },
    });

    const skillFile = path.join(directory, ".agents/skills/swizzle-builder/SKILL.md");
    await writeFile(skillFile, "a local edit\n");
    expect(await install()).toEqual({
      exitCode: 8,
      output: {
        error: `A different swizzle-builder skill is already installed at ${path.dirname(skillFile)}.`,
        code: "SKILL_CHANGED",
        help: [
          `Run \`swizzle skill install --dir ${directory} --force\``,
          "The installed copy differs from this CLI's skill, from an older CLI or a local edit. --force replaces it.",
        ],
      },
    });
    expect(await readFile(skillFile, "utf8")).toBe("a local edit\n");
    expect(await install("--force")).toMatchObject({
      exitCode: 0,
      output: { skill: { state: "replaced" } },
    });

    // An extra symlink and a file in the skill's place are changes too, and --force replaces them.
    const skillDirectory = path.dirname(skillFile);
    await symlink("SKILL.md", path.join(skillDirectory, "extra"));
    expect((await install()).output.code).toBe("SKILL_CHANGED");
    expect((await install("--force")).output.skill.state).toBe("replaced");
    await rm(skillDirectory, { recursive: true });
    await writeFile(skillDirectory, "not a skill\n");
    expect((await install()).output.code).toBe("SKILL_CHANGED");
    expect((await install("--force")).output.skill.state).toBe("replaced");
    expect(await readFile(skillFile, "utf8")).not.toBe("a local edit\n");
  });

  it("leaves symlink skill targets unchanged", async () => {
    const directory = await temporaryDirectory("swizzle-cli-skill-symlink-");
    const linkedTarget = await temporaryDirectory("swizzle-cli-skill-linked-");
    const skillParent = path.join(directory, ".agents/skills");
    await mkdir(skillParent, { recursive: true });
    await symlink(linkedTarget, path.join(skillParent, "swizzle-builder"), "dir");

    const io = createBufferIO();
    const exitCode = await runCli(["skill", "install", "--dir", directory], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toContain("left unchanged");
    expect(await readlink(path.join(skillParent, "swizzle-builder"))).toBe(linkedTarget);
  });

  it("creates a standalone automations workspace", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-workspace-");
    const workspace = path.join(directory, "demo");

    const exitCode = await runCli(["workspace", "init", workspace], io);

    expect(exitCode).toBe(0);
    expect(io.stdoutText).toContain(`workspace:\n  directory: ${workspace}\n`);
    expect(await readdir(path.join(workspace, "automations"))).toEqual([]);
    const agents = await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    const readme = await readFile(path.join(workspace, "README.md"), "utf8");
    expect(agents).toContain("<INSTANCE_URL>");
    // The instance refuses validate while a declared secret is missing, so both guides store it first.
    expect(readme.match(/swizzle profile add .*/gu)).toEqual([
      "swizzle profile add <PROFILE_NAME> --url <INSTANCE_URL> --token-env SWIZZLE_TOKEN --env <ENVIRONMENT_NAME> --default",
    ]);
    for (const guide of [agents, readme]) {
      expect(guide.indexOf("swizzle secret set")).toBeGreaterThan(-1);
      expect(guide.indexOf("swizzle secret set")).toBeLessThan(guide.indexOf("swizzle validate"));
    }
    expect(await readFile(path.join(workspace, "scripts/update-toolkit.sh"), "utf8")).toContain(
      "swizzle skill install --dir",
    );
    expect(
      await readFile(path.join(workspace, ".agents/skills/swizzle-builder/SKILL.md"), "utf8"),
    ).toContain("Swizzle");
    expect((await lstat(path.join(workspace, ".claude/skills"))).isSymbolicLink()).toBe(true);
  });

  it("refuses non-empty workspace targets unless force is set", async () => {
    const directory = await temporaryDirectory("swizzle-cli-workspace-force-");
    await writeFile(path.join(directory, "old.txt"), "old", "utf8");

    const refusedIo = createBufferIO();
    const refusedExitCode = await runCli(["workspace", "init", directory, "--json"], refusedIo);
    expect(refusedExitCode).toBe(8);
    expect(JSON.parse(refusedIo.stdoutText).code).toBe("WORKSPACE_NOT_EMPTY");

    const forcedIo = createBufferIO();
    const forcedExitCode = await runCli(["workspace", "init", directory, "--force"], forcedIo);
    expect(forcedExitCode).toBe(0);
    expect(await readdir(path.join(directory, "automations"))).toEqual([]);
  });

  it("protects existing non-empty directories during init", async () => {
    const io = createBufferIO();
    const directory = await temporaryDirectory("swizzle-cli-init-existing-");

    await writeFile(path.join(directory, "keep.txt"), "already here", "utf8");

    const exitCode = await runCli(["init", directory], io);

    expect(exitCode).toBe(8);
    expect(io.stdoutText).toBe(
      [
        `error: ${directory} already exists and is not empty.`,
        "code: INIT_TARGET_NOT_EMPTY",
        "help[1]: Pass a new directory; init never writes into one that holds files.",
        "",
      ].join("\n"),
    );
    expect(await readdir(directory)).toEqual(["keep.txt"]);
  });
});

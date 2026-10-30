// Drives validation and custom-image readiness on a private packaged stack, including its broker.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { get, type PackagedStack, startPackagedStack, until } from "./packaged-stack.mts";

export async function verifyRuntimeReadiness(evidenceDirectory: string): Promise<void> {
  const evidence = path.resolve(evidenceDirectory);
  await mkdir(evidence, { recursive: true });
  const log = (message: string) => process.stderr.write(`runtime-readiness: ${message}\n`);
  const deadlines = { build: 600_000, run: 60_000, exec: 60_000, ps: 5_000, image: 5_000 };
  const docker = async (command: keyof typeof deadlines, ...args: string[]) =>
    (
      await promisify(execFile)("docker", [command, ...args], {
        maxBuffer: 4 * 1024 * 1024,
        signal: AbortSignal.timeout(deadlines[command]),
        killSignal: "SIGKILL",
      })
    ).stdout;
  const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-readiness-"));
  const image = `swizzle-readiness:${randomUUID()}`;
  const legacyImage = `${image}-legacy`;
  let stack: PackagedStack | undefined;
  const save = async (name: string, value: unknown) =>
    writeFile(
      path.join(evidence, name),
      `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`,
    );
  try {
    const runningStack = await startPackagedStack("smoke", log);
    stack = runningStack;
    const workers = JSON.parse(
      (await get(`${runningStack.api}/workers`, runningStack.token)) ?? "{}",
    ).workers;
    const worker = workers.find((entry: { kind: string }) => entry.kind === "local");
    assert.ok(worker?.capabilities, "local worker reported capabilities");
    const runner = `${runningStack.project}-runner-base`;
    const actual = JSON.parse(
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        runner,
        "-e",
        `const {execFileSync}=require('node:child_process'); console.log(JSON.stringify({python:execFileSync('python3',['--version'],{encoding:'utf8'}).trim().replace('Python ',''),npm:!!execFileSync('npm',['--version']),pip:!!execFileSync('python3',['-m','pip','--version'])}));`,
      ),
    );
    assert.equal(
      worker.capabilities.languages.find((entry: { name: string }) => entry.name === "python")
        ?.version,
      actual.python,
    );
    assert.deepEqual(worker.capabilities.dependencyPackaging, {
      node: actual.npm,
      python: actual.pip,
    });
    const workerContainer = (
      await docker(
        "ps",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${runningStack.project}`,
        "--filter",
        "label=com.docker.compose.service=worker",
      )
    ).trim();
    await save("A4-runner-and-worker.json", {
      actualRunner: actual,
      reportedWorker: worker.capabilities,
      workerPython: (await docker("exec", workerContainer, "python3", "--version")).trim(),
    });
    log("A4: worker reports the runner's languages and packaging");

    const context = path.join(directory, "image");
    await mkdir(context);
    await writeFile(
      path.join(context, "Dockerfile"),
      `FROM ${runner}\nUSER root\nRUN printf '#!/bin/sh\\necho image-only-7.2\\n' > /usr/local/bin/image-only && chmod 755 /usr/local/bin/image-only && rm -f /usr/bin/pdftoppm /usr/bin/python3 && printf '#!/bin/sh\\nexit 0\\n' > /usr/local/bin/quiet-tool && chmod 755 /usr/local/bin/quiet-tool\nCOPY runner-tools.json /etc/swizzle/runner-tools.json\n`,
    );
    const inventory = JSON.parse(
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "cat",
        runner,
        "/etc/swizzle/runner-tools.json",
      ),
    );
    inventory.binaries = inventory.binaries.filter(
      (tool: { name: string }) => tool.name !== "pdftoppm" && tool.name !== "python3",
    );
    inventory.languages = inventory.languages.filter(
      (language: { name: string }) => language.name !== "python",
    );
    inventory.dependencyPackaging.python = false;
    inventory.binaries.push(
      { name: "image-only", version: "7.2" },
      { name: "quiet-tool", version: null },
    );
    await writeFile(path.join(context, "runner-tools.json"), JSON.stringify(inventory));
    await docker("build", "--tag", image, context);
    const automation = path.join(directory, "automation");
    await mkdir(automation);
    await writeFile(path.join(automation, "main.js"), "console.log(JSON.stringify({ok:true}));\n");
    const config = (binary: string, version?: string, signing = false) =>
      `name: readiness-probe\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /hooks/readiness-probe\n${signing ? "  signature: { header: x-signature, secret: GREETER_SIGNING_SECRET }\n" : ""}runtime:\n  execution_mode: container\n  permissions: { network: false }\n  container: { base_image: ${image} }\n  retry: { max_attempts: 1 }\n  requirements:\n    binaries: [{ name: ${binary}${version ? `, version: '${version}'` : ""} }]\n`;
    await writeFile(path.join(automation, "config.yaml"), config("image-only", ">=7"));
    const accepted = JSON.parse(await runningStack.cli("validate", automation));
    assert.equal(accepted.checks.readiness, "ready (the target's workers)");
    await save("A3-custom-only-accepted.json", accepted);
    await runningStack.cli("apply", automation);
    const queued = JSON.parse(await runningStack.cli("trigger", "readiness-probe"));
    await save("A3-trigger.json", queued);
    const runId = queued.runId ?? queued.run?.id;
    assert.equal(typeof runId, "string");
    const completed = await until(
      "custom-image run succeeded",
      async () => {
        const run = JSON.parse(
          (await get(`${runningStack.api}/runs/${runId}`, runningStack.token)) ?? "{}",
        );
        if (["failed", "dead-lettered"].includes(run.status)) throw new Error(JSON.stringify(run));
        return run.status === "succeeded" ? run : undefined;
      },
      log,
    );
    await save("A3-run.json", completed);

    const legacyContext = path.join(directory, "legacy-image");
    await mkdir(legacyContext);
    await writeFile(
      path.join(legacyContext, "Dockerfile"),
      `FROM ${image}\nUSER root\nRUN rm /etc/swizzle/runner-tools.json\n`,
    );
    await docker("build", "--tag", legacyImage, legacyContext);
    const legacyAutomation = path.join(directory, "legacy-automation");
    await mkdir(legacyAutomation);
    await writeFile(
      path.join(legacyAutomation, "main.js"),
      "const {execFileSync}=require('node:child_process'); console.log(JSON.stringify({tool:execFileSync('image-only',[],{encoding:'utf8'}).trim()}));\n",
    );
    await writeFile(
      path.join(legacyAutomation, "config.yaml"),
      config("image-only", ">=7")
        .replaceAll("readiness-probe", "legacy-readiness-probe")
        .replace(image, legacyImage),
    );
    const legacyApply = JSON.parse(await runningStack.cli("apply", legacyAutomation));
    assert.equal(legacyApply.deployment.readiness, "ready");
    await save("compat-A1-apply.json", legacyApply);
    const legacyInspect = JSON.parse(await runningStack.cli("inspect", "legacy-readiness-probe"));
    assert.equal(legacyInspect.automation.ready, "yes");
    assert.match(
      JSON.stringify(legacyInspect.automation.readinessWarnings),
      /unverified.*image-only >=7/u,
    );
    assert.match(JSON.stringify(legacyInspect.automation.readinessWarnings), /language node/u);
    assert.match(
      JSON.stringify(legacyInspect.automation.readinessWarnings),
      /infra\/docker\/runner-tools.mjs/u,
    );
    await save("compat-A1-inspect.json", legacyInspect);
    const legacyQueued = JSON.parse(await runningStack.cli("trigger", "legacy-readiness-probe"));
    const legacyRunId = legacyQueued.runId ?? legacyQueued.run?.id;
    assert.equal(typeof legacyRunId, "string");
    const legacyRun = await until(
      "legacy custom-image run succeeded",
      async () => {
        const run = JSON.parse(
          (await get(`${runningStack.api}/runs/${legacyRunId}`, runningStack.token)) ?? "{}",
        );
        if (["failed", "dead-lettered"].includes(run.status)) throw new Error(JSON.stringify(run));
        return run.status === "succeeded" ? run : undefined;
      },
      log,
    );
    assert.deepEqual(legacyRun.result, { tool: "image-only-7.2" });
    await save("compat-A1-run.json", legacyRun);
    const browser = async (...args: string[]) =>
      promisify(execFile)("chrome-devtools-axi", args, {
        env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: "custom-image-compat" },
        maxBuffer: 1024 * 1024,
      }).catch(() => {
        throw new Error(`Browser proof step ${args[0]} failed.`);
      });
    try {
      const password = /^SWIZZLE_SETUP_TOKEN=(.+)$/mu.exec(
        await readFile(runningStack.envFile, "utf8"),
      )?.[1];
      assert.ok(password);
      await browser("open", runningStack.dashboard);
      await browser("resize", "1280", "720");
      await browser(
        "eval",
        `async () => {
        const response = await fetch('/api/auth/sign-in/email', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'smoke@swizzle.test', password: ${JSON.stringify(password)}})});
        if (!response.ok) throw new Error('Sign in failed');
        location.href = '/automations/legacy-readiness-probe';
        return 'Signed in';
      }`,
      );
      await browser("wait", "are unverified");
      await save("compat-A1-dashboard.txt", (await browser("snapshot")).stdout);
      await browser("screenshot", path.join(evidence, "compat-A1-dashboard.png"));
    } finally {
      await browser("stop");
    }
    log(
      "compat A1: image without a record deploys, runs its binary, and shows unverified requirements",
    );
    try {
      await runningStack.compose("pause", "worker");
      const stalled = JSON.parse(await runningStack.cli("inspect", "legacy-readiness-probe"));
      assert.match(stalled.automation.ready, /^no: .*response deadline/u);
      await save("review-unresponsive-inspect.json", stalled);
    } finally {
      await runningStack.compose("unpause", "worker");
    }
    const resumed = JSON.parse(await runningStack.cli("inspect", "legacy-readiness-probe"));
    assert.equal(resumed.automation.ready, "yes");
    await save("review-resumed-inspect.json", resumed);
    log(
      "review: inspect reports the image issue before its client times out and recovers when the worker answers",
    );
    await writeFile(path.join(automation, "config.yaml"), config("pdftoppm"));
    let refused = "";
    try {
      await runningStack.cli("validate", automation);
    } catch (error) {
      refused = String(error);
    }
    assert.match(refused, /BINARY_REQUIREMENT_MISSING|lacks the binary pdftoppm/u);
    await save("A3-default-only-refused.txt", refused);
    log("A3: selected image accepts its own binary and refuses a default-only binary");
    const languageDirectory = path.join(directory, "language-only");
    await mkdir(languageDirectory);
    await writeFile(path.join(languageDirectory, "main.js"), "console.log('{}');\n");
    await writeFile(path.join(languageDirectory, "main.py"), "print('{}')\n");
    const languageConfig = {
      name: "language-only",
      version: "1.0.0",
      entrypoint: "main.js",
      trigger: { type: "webhook", path: "/hooks/language-only" },
      runtime: {
        execution_mode: "container",
        container: { base_image: image },
        permissions: { network: false },
      },
    };
    await writeFile(path.join(languageDirectory, "config.yaml"), JSON.stringify(languageConfig));
    const nodeOnly = JSON.parse(await runningStack.cli("validate", languageDirectory));
    assert.equal(nodeOnly.checks.readiness, "ready (the target's workers)");
    await save("review-language-only-accepted.json", nodeOnly);
    await writeFile(
      path.join(languageDirectory, "config.yaml"),
      JSON.stringify({ ...languageConfig, entrypoint: "main.py" }),
    );
    let absentLanguage = "";
    try {
      await runningStack.cli("validate", languageDirectory);
    } catch (error) {
      absentLanguage = String(error);
    }
    assert.match(absentLanguage, /LANGUAGE_RUNTIME_UNAVAILABLE|does not run python/u);
    await save("review-language-only-refused.txt", absentLanguage);
    log("review: custom-image language is checked without binary declarations");

    await writeFile(path.join(automation, "config.yaml"), config("quiet-tool", ">=7"));
    let unknownVersion = "";
    try {
      await runningStack.cli("validate", automation);
    } catch (error) {
      unknownVersion = String(error);
    }
    assert.match(unknownVersion, /BINARY_VERSION_UNSUPPORTED|version it cannot tell/u);
    await save("A2-unknown-version-refused.txt", unknownVersion);

    await writeFile(path.join(automation, "config.yaml"), config("image-only", ">=7", true));
    // Local authoring does not need the platform signing secret to print its summary.
    const { runCli } = await import("@swizzle/cli");
    process.env.SWIZZLE_CONFIG_HOME = path.join(directory, "local-cli");
    delete process.env.SWIZZLE_PROFILE;
    let stdout = "";
    const code = await runCli(["validate", automation, "--json"], {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: () => {},
    });
    await save("A1-validation.json", { exitCode: code, output: JSON.parse(stdout) });
    // Missing runtime binary locally affects readiness, not the authoring summary.
    assert.equal(JSON.parse(stdout).automation.requirements, "image-only >=7");
    assert.equal(JSON.parse(stdout).automation.secrets, "GREETER_SIGNING_SECRET");
    log("A1: validation lists binaries and signing secrets");
  } finally {
    try {
      await stack?.remove();
    } finally {
      try {
        if (stack !== undefined) await docker("image", "rm", image, legacyImage).catch(() => {});
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const evidence = process.argv[2];
  if (!evidence) throw new Error("Pass an evidence directory.");
  await verifyRuntimeReadiness(evidence);
}

// `just verify-upgrade`: the latest stable release's data survives an upgrade to this exact HEAD.
// A local origin and a test-only release tag keep the check independent of published releases.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { APP_VERSION } from "@swizzle/core";
import type {
  ApplyResponse,
  HealthResponse,
  ProjectsResponse,
  RunResponse,
  RunsResponse,
} from "@swizzle/runtime/http-contract";
import {
  cleanUpOnSignal,
  get,
  type PackagedStack,
  startPackagedStack,
  until,
} from "./packaged-stack.mts";

const execute = promisify(execFile);
const log = (message: string) => process.stdout.write(`upgrade-check: ${message}\n`);
const source = process.cwd();
const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-upgrade-"));
const checkout = path.join(directory, "checkout");
const origin = path.join(directory, "origin.git");
const evidence = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const targetTag = `v${APP_VERSION}`;
let stack: PackagedStack | undefined;
const registry = `swizzle-upgrade-registry-${randomBytes(6).toString("hex")}`;

async function command(program: string, args: string[], cwd = checkout): Promise<string> {
  const result = await execute(program, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return result.stdout;
}

async function request(route: string, method = "GET", body?: unknown, cookie?: string) {
  assert.ok(stack);
  const response = await fetch(`${stack.dashboard}/api${route}`, {
    method,
    headers: {
      origin: stack.dashboard,
      "content-type": "application/json",
      ...(cookie === undefined ? { authorization: `Bearer ${stack.token}` } : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(
    response.ok,
    `${method} ${route}: ${response.status} ${response.ok ? "" : await response.text()}`,
  );
  return response;
}

async function runWithSecret(expectedHash: string): Promise<string> {
  const { runId } = (await (await request("/upgrade-proof", "POST", {})).json()) as {
    runId: string;
  };
  await until(
    `run ${runId} succeeded with the original secret`,
    async () => {
      const run: RunResponse = await (await request(`/runs/${runId}?environment=staging`)).json();
      if (["failed", "dead-lettered"].includes(run.status))
        throw new Error(`Run ${runId}: ${JSON.stringify(run)}`);
      if (run.status !== "succeeded") return undefined;
      assert.deepEqual(run.result, { secretSha256: expectedHash });
      return true;
    },
    log,
  );
  return runId;
}

interface WebhookProof {
  readonly name: string;
  readonly fixture: string;
  readonly url: string;
  readonly oldRun: string;
}

async function signedWebhook(url: string, name: string, secret: string): Promise<string> {
  const body = JSON.stringify({ delivery: name });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-swizzle-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(response.status, 200, `POST ${url}: ${await response.clone().text()}`);
  const { runId } = (await response.json()) as { runId: string };
  await until(
    `signed POST ${url} runs ${name}: ${runId}`,
    async () => {
      const run: RunResponse = await (await request(`/runs/${runId}?environment=staging`)).json();
      assert.equal(run.automationSlug, name);
      if (["failed", "dead-lettered"].includes(run.status)) throw new Error(JSON.stringify(run));
      if (run.status !== "succeeded") return undefined;
      assert.deepEqual(run.payload, { delivery: name });
      return true;
    },
    log,
  );
  return runId;
}

async function inspectWebhook(name: string): Promise<string> {
  assert.ok(stack);
  const inspected = JSON.parse(await stack.cli("inspect", name)) as {
    automation: { webhookUrl: string };
  };
  assert.ok(inspected.automation.webhookUrl);
  return inspected.automation.webhookUrl;
}

cleanUpOnSignal(async () => {
  await command("docker", ["rm", "--force", "--volumes", registry], source).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});
try {
  const head = (await command("git", ["rev-parse", "HEAD"], source)).trim();
  const sourceTag = (await command("git", ["tag", "--sort=-version:refname"], source))
    .split("\n")
    .find((tag) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag));
  assert.ok(
    sourceTag,
    "No stable release tag found. Fetch release tags before running this proof.",
  );
  const sourceCommit = (
    await command("git", ["rev-parse", `${sourceTag}^{commit}`], source)
  ).trim();
  assert.notEqual(
    sourceCommit,
    head,
    "HEAD is already the latest stable release; run on the upgrade target.",
  );
  await command("git", ["clone", "--bare", "--shared", source, origin], source);
  const unrelated = (await command("git", ["--git-dir", origin, "tag", "--list"], source))
    .trim()
    .split("\n")
    .filter((tag) => tag !== sourceTag && tag !== targetTag);
  if (unrelated.length > 0)
    await command("git", ["--git-dir", origin, "tag", "--delete", ...unrelated], source);
  await command("git", ["--git-dir", origin, "tag", "--force", targetTag, head], source);
  await command(
    "docker",
    ["run", "--detach", "--name", registry, "--publish", "127.0.0.1::5000", "registry:3"],
    source,
  );
  const registryAddress = (await command("docker", ["port", registry, "5000/tcp"], source)).trim();
  process.env.SWIZZLE_IMAGE_REGISTRY = `${registryAddress}/swizzletech`;

  await command("git", ["clone", "--shared", "--no-checkout", origin, checkout], source);
  await command("git", ["checkout", "--detach", sourceCommit]);
  log(
    `source ${sourceTag}; target ${head}; local test tag ${targetTag}; code version ${APP_VERSION}`,
  );
  stack = await startPackagedStack("smoke", log, checkout, { SWIZZLE_ENVIRONMENT: "staging" });
  await copyFile(stack.envFile, path.join(checkout, ".env"));
  const originalEnv = await readFile(path.join(checkout, ".env"), "utf8");
  // Generate and deploy through the released CLI, not a reconstruction of its scaffold.
  await command("just", [
    "--command",
    "mise",
    "exec",
    "--",
    "pnpm",
    "install",
    "--frozen-lockfile",
  ]);
  const releasedCli = (...args: string[]) =>
    command(process.execPath, [
      "--import",
      "tsx",
      "--conditions=swizzle-source",
      "apps/cli/src/bin.ts",
      ...args,
      "--json",
    ]);
  const legacyFixture = path.join(directory, "legacy-scaffold");
  await releasedCli("init", legacyFixture, "--template", "node");
  const legacyConfig = await readFile(path.join(legacyFixture, "config.yaml"), "utf8");
  const signingName = /secret: (\S+)/u.exec(legacyConfig)?.[1];
  const legacyPath = /path: (\S+)/u.exec(legacyConfig)?.[1];
  assert.ok(signingName);
  assert.ok(legacyPath);
  assert.ok(legacyPath.startsWith("/hooks/legacy-scaffold-"));
  const signingSecret = randomBytes(32).toString("hex");
  await request(`/secrets/${signingName}?environment=staging`, "PUT", { value: signingSecret });
  const legacyWebhooks: WebhookProof[] = [];
  for (const [name, route] of [
    ["legacy-scaffold", legacyPath],
    ["legacy-orders", "/orders"],
    ["legacy-shadow", legacyPath.slice("/hooks".length)],
  ]) {
    assert.ok(name && route);
    const fixture = path.join(directory, name);
    if (fixture !== legacyFixture) {
      await cp(legacyFixture, fixture, { recursive: true });
      await writeFile(
        path.join(fixture, "config.yaml"),
        legacyConfig
          .replace("name: legacy-scaffold", `name: ${name}`)
          .replace(`path: ${legacyPath}`, `path: ${route}`),
      );
    }
    await releasedCli("apply", fixture);
    const inspected = JSON.parse(await releasedCli("inspect", name)) as {
      automation: { webhookUrl: string };
    };
    const url = inspected.automation.webhookUrl;
    assert.ok(url);
    const printed = new URL(url);
    assert.equal(printed.pathname, route);
    assert.equal(printed.searchParams.get("environment"), "staging");
    const oldRun = await signedWebhook(url, name, signingSecret);
    legacyWebhooks.push({ name, fixture, url, oldRun });
  }
  log(
    "released CLI scaffold and authored /orders and shadow paths are deployed and signed deliveries succeed",
  );

  const password = /^SWIZZLE_SETUP_TOKEN=(.+)$/mu.exec(originalEnv)?.[1];
  assert.ok(password);
  const project = (await (
    await request("/projects", "POST", { name: "Upgrade proof", slug: "upgrade-proof" })
  ).json()) as { id: string };
  const secret = randomBytes(32).toString("hex");
  await request("/secrets/UPGRADE_SECRET?environment=staging&project=upgrade-proof", "PUT", {
    value: secret,
  });
  const fixture = path.join(directory, "automation");
  await mkdir(fixture);
  await writeFile(
    path.join(fixture, "config.yaml"),
    `name: upgrade-proof
version: 1.0.0
entrypoint: main.js
trigger:
  type: webhook
  path: /upgrade-proof
runtime:
  language: node
  execution_mode: host
  profile: host-default
  timeout: 30s
  permissions:
    network: false
    writable_dirs: []
  retry:
    max_attempts: 1
    backoff: exponential
  requirements:
    binaries: []
secrets:
  - UPGRADE_SECRET
api_check:
  mode: passive
`,
  );
  await writeFile(
    path.join(fixture, "main.js"),
    `const {createHash} = require('node:crypto'); console.log(JSON.stringify({secretSha256: createHash('sha256').update(process.env.UPGRADE_SECRET).digest('hex')}));\n`,
  );
  await stack.cli("apply", fixture, "--project", "upgrade-proof");
  const hash = createHash("sha256").update(secret).digest("hex");
  const oldRun = await runWithSecret(hash);
  const cronFixture = path.join(directory, "cron");
  await mkdir(cronFixture);
  await writeFile(
    path.join(cronFixture, "config.yaml"),
    (await readFile(path.join(fixture, "config.yaml"), "utf8"))
      .replace("name: upgrade-proof", "name: upgrade-cron")
      .replace("  type: webhook\n  path: /upgrade-proof", "  type: cron\n  every: 30s"),
  );
  await copyFile(path.join(fixture, "main.js"), path.join(cronFixture, "main.js"));
  await stack.cli("apply", cronFixture, "--project", "upgrade-proof");
  async function waitForCron(excluding: readonly string[] = [], queuedAfter = 0) {
    return await until(
      "staging cron succeeds with its existing secret",
      async () => {
        const runs: RunsResponse = await (
          await request("/dashboard/runs?environment=staging&automation=upgrade-cron")
        ).json();
        const run = runs.runs.find(
          (run) =>
            run.triggerType === "cron" &&
            run.status === "succeeded" &&
            !excluding.includes(run.runId) &&
            Date.parse(run.queuedAt) >= queuedAfter,
        );
        if (!run) return undefined;
        const detail: RunResponse = await (
          await request(`/runs/${run.runId}?environment=staging`)
        ).json();
        assert.deepEqual(detail.result, { secretSha256: hash });
        return run.runId;
      },
      log,
    );
  }
  const oldCron = await waitForCron();
  const beforeCronRuns: RunsResponse = await (
    await request("/dashboard/runs?environment=staging&automation=upgrade-cron")
  ).json();
  log(`${sourceTag} staging cron succeeded: ${oldCron}`);

  const bootstrap = path.join(checkout, ".git", "swizzle-upgrade.ts");
  await command("git", ["tag", "v999.0.0", sourceCommit]);
  await command("git", ["tag", "--force", targetTag, sourceCommit]);
  await command("git", ["fetch", "--no-tags", "origin", `refs/tags/${targetTag}`]);
  await writeFile(bootstrap, await command("git", ["show", "FETCH_HEAD:scripts/upgrade.ts"]));
  await writeFile(
    path.join(checkout, ".git", "stack-images.ts"),
    await command("git", ["show", "FETCH_HEAD:scripts/stack-images.ts"]),
  );
  const beforeRef = await command("git", ["rev-parse", "HEAD"]);
  const beforeContainers = await stack.compose("ps", "-q");
  await writeFile(path.join(checkout, "operator-note"), "uncommitted operator file\n");
  await assert.rejects(
    command(process.execPath, [bootstrap, targetTag]),
    /Checkout has uncommitted changes/u,
  );
  assert.equal(await command("git", ["rev-parse", "HEAD"]), beforeRef);
  assert.equal(await readFile(path.join(checkout, ".env"), "utf8"), originalEnv);
  assert.equal(await stack.compose("ps", "-q"), beforeContainers);
  await rm(path.join(checkout, "operator-note"));
  log("dirty checkout refused; original commit, .env and running container IDs are unchanged");
  const upgraded = await command(process.execPath, [bootstrap]);
  const upgradedAt = Date.now();
  process.stdout.write(upgraded);
  assert.equal((await command("git", ["rev-parse", "HEAD"])).trim(), head);
  assert.equal((await command("git", ["rev-parse", "v999.0.0"])).trim(), beforeRef.trim());
  assert.equal((await command("git", ["rev-parse", targetTag])).trim(), beforeRef.trim());
  log(
    "newest stable release came from origin despite a higher local-only tag and a conflicting local target tag",
  );
  const backupPath = /^Backup: (.+)$/mu.exec(upgraded)?.[1];
  assert.ok(backupPath);
  assert.ok((await readFile(path.join(backupPath, "database.sql"))).length > 0);
  assert.equal(await readFile(path.join(backupPath, "..", "env"), "utf8"), originalEnv);
  assert.equal(
    await readFile(path.join(checkout, ".env"), "utf8"),
    originalEnv.replace(/^SWIZZLE_IMAGE_TAG=.*\n/gmu, ""),
  );
  log("upgrade recipe completed; database, artifacts and original .env are backed up");
  const login = await request("/auth/sign-in/email", "POST", {
    email: "smoke@swizzle.test",
    password,
  });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie.includes("session_token="));
  const projects: ProjectsResponse = await (
    await request("/projects", "GET", undefined, cookie)
  ).json();
  assert.ok(projects.projects.some(({ id }) => id === project.id));
  const runs: RunsResponse = await (
    await request("/dashboard/runs?environment=staging", "GET", undefined, cookie)
  ).json();
  assert.ok(runs.runs.some(({ runId }) => runId === oldRun));
  const newRun = await runWithSecret(hash);
  const webhookEvidence = [];
  for (const webhook of legacyWebhooks) {
    assert.equal(await inspectWebhook(webhook.name), webhook.url);
    const upgradedRun = await signedWebhook(webhook.url, webhook.name, signingSecret);
    // Force exercises trigger registration even when an unchanged apply could be a no-op.
    const applied: ApplyResponse = JSON.parse(await stack.cli("apply", webhook.fixture, "--force"));
    assert.equal(applied.webhookUrl, webhook.url);
    const redeployedUrl = await inspectWebhook(webhook.name);
    assert.equal(redeployedUrl, webhook.url);
    const redeployedRun = await signedWebhook(redeployedUrl, webhook.name, signingSecret);
    const detail = (await (
      await request(`/dashboard/automations/${webhook.name}?environment=staging`)
    ).json()) as {
      trigger: { webhookUrl: string };
    };
    assert.equal(detail.trigger.webhookUrl, webhook.url);
    webhookEvidence.push({
      name: webhook.name,
      oldUrl: webhook.url,
      redeployedUrl,
      oldRun: webhook.oldRun,
      upgradedRun,
      redeployedRun,
    });
  }
  const denied: { host: string; route: string; status: number }[] = [];
  for (const host of [new URL(stack.api).host, new URL(stack.dashboard).host]) {
    for (const route of [
      "/orders",
      "/api/health",
      "/api/auth/sign-in/email",
      "/",
      "/sign-in",
      "/auth/sign-in/email",
    ]) {
      const response: Response = await fetch(`${stack.links}${route}`, {
        method: "POST",
        headers: { host },
      });
      assert.equal(response.status, 404);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("set-cookie"), null);
      denied.push({ host, route, status: response.status });
    }
    const response: Response = await fetch(`${stack.links}/hooks/auth/sign-in/email`, {
      method: "POST",
      headers: { host },
    });
    assert.equal(response.status, 404);
    assert.match(await response.text(), /WEBHOOK_NOT_AVAILABLE/u);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const fresh = path.join(directory, "fresh-scaffold");
  await stack.cli("init", fresh, "--template", "node");
  const freshConfig = await readFile(path.join(fresh, "config.yaml"), "utf8");
  const freshSecret = /secret: (\S+)/u.exec(freshConfig)?.[1];
  assert.ok(freshSecret);
  await request(`/secrets/${freshSecret}?environment=staging`, "PUT", { value: signingSecret });
  await stack.cli("apply", fresh);
  const freshUrl = await inspectWebhook("fresh-scaffold");
  assert.match(new URL(freshUrl).pathname, /^\/hooks\/fresh-scaffold-/u);
  const freshRun = await signedWebhook(freshUrl, "fresh-scaffold", signingSecret);
  // Exercise the same printed path through the limited public listener as well.
  const publicUrl = new URL(freshUrl);
  const publicPath = publicUrl.pathname;
  const publicRun = await signedWebhook(
    `${stack.links}${publicPath}${publicUrl.search}`,
    "fresh-scaffold",
    signingSecret,
  );
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, "upgrade-webhooks.json"),
      `${JSON.stringify(
        {
          head,
          webhooks: webhookEvidence,
          denied,
          fresh: { url: freshUrl, runId: freshRun, publicRun },
        },
        null,
        2,
      )}\n`,
    );
  }

  const newCron = await waitForCron(
    beforeCronRuns.runs.map((run) => run.runId),
    upgradedAt,
  );
  const afterCronRuns: RunsResponse = await (
    await request("/dashboard/runs?environment=staging&automation=upgrade-cron")
  ).json();
  assert.ok(afterCronRuns.runs.some((run) => run.runId === oldCron));
  const environments = (await (await request("/environments")).json()) as {
    defaultEnvironment: string;
  };
  assert.equal(environments.defaultEnvironment, "staging");
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, "upgrade-staging-cron.json"),
      `${JSON.stringify({ oldCron, newCron, defaultEnvironment: environments.defaultEnvironment, runs: afterCronRuns.runs }, null, 2)}\n`,
    );
  }
  log(`upgraded staging cron still fires and decrypts the original secret: ${newCron}`);

  log(
    "existing owner signs in; original project and finished run are listed; deployed source still decrypts and uses its secret",
  );
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, "upgrade-result.json"),
      `${JSON.stringify({ head, sourceTag, sourceCommit, version: APP_VERSION, oldRun, newRun }, null, 2)}\n`,
    );
  }
  const privateApiBase = `${stack.dashboard}/api`;
  // HEAD and the latest stable tag can share a version before the next bump. A distinct stale
  // value makes the observation sensitive to the old Compose-to-API override as well.
  await writeFile(
    path.join(checkout, ".env"),
    `${originalEnv
      .replace(/^SWIZZLE_IMAGE_TAG=.*\n/gmu, "")
      .replace(/^SWIZZLE_PUBLIC_URL=.*$/gmu, `SWIZZLE_PUBLIC_URL=${stack.links}`)
      .replace(
        /^SWIZZLE_API_ORIGIN=.*$/gmu,
        `SWIZZLE_API_ORIGIN=${privateApiBase}`,
      )}SWIZZLE_IMAGE_TAG=v0.0.0\n`,
  );
  // Configuration changes use the same release image selection as an operator's restart.
  await command("just", ["stack"]);
  assert.doesNotMatch(await readFile(path.join(checkout, ".env"), "utf8"), /^SWIZZLE_IMAGE_TAG=/mu);
  const health: HealthResponse = JSON.parse((await get(`${stack.dashboard}/api/health`)) ?? "null");
  assert.equal(health.version, APP_VERSION);
  log(`just stack removed stale image tag v0.0.0; /health reports code version ${health.version}`);
  const doctor = JSON.parse(await stack.cli("doctor")) as { serverVersion: string };
  assert.equal(doctor.serverVersion, APP_VERSION);
  log(`swizzle doctor reports serverVersion ${doctor.serverVersion}`);
  const privateInstance = [];
  for (const webhook of legacyWebhooks) {
    const original = new URL(webhook.url);
    const expected: string = original.pathname.startsWith("/hooks/")
      ? `${stack.links}${original.pathname}${original.search}`
      : `${privateApiBase}${original.pathname}${original.search}`;
    const printedUrl = await inspectWebhook(webhook.name);
    assert.equal(printedUrl, expected);
    const applied: ApplyResponse = JSON.parse(await stack.cli("apply", webhook.fixture, "--force"));
    assert.equal(applied.webhookUrl, expected);
    const detail = (await (
      await request(`/dashboard/automations/${webhook.name}?environment=staging`)
    ).json()) as {
      trigger: { webhookUrl: string };
    };
    assert.equal(detail.trigger.webhookUrl, expected);
    const runId = await signedWebhook(printedUrl, webhook.name, signingSecret);
    privateInstance.push({ name: webhook.name, originalUrl: webhook.url, printedUrl, runId });
  }
  const freshPublicUrl = await inspectWebhook("fresh-scaffold");
  assert.ok(freshPublicUrl.startsWith(`${stack.links}/hooks/`));
  const freshPublicRun = await signedWebhook(freshPublicUrl, "fresh-scaffold", signingSecret);
  if (evidence)
    await writeFile(
      path.join(evidence, "upgrade-private-listener.json"),
      `${JSON.stringify(
        {
          head,
          publicBase: stack.links,
          apiBase: privateApiBase,
          webhooks: privateInstance,
          fresh: { printedUrl: freshPublicUrl, runId: freshPublicRun },
        },
        null,
        2,
      )}\n`,
    );
  log(
    "with PUBLIC_URL on the restricted listener, root webhook URLs use the private API and every printed URL runs",
  );
  const restore = /^Restore with: (.+)$/mu.exec(upgraded)?.[1];
  assert.ok(restore);
  process.stdout.write(await command("bash", ["-euo", "pipefail", "-c", restore]));
  assert.equal((await command("git", ["rev-parse", "HEAD"])).trim(), beforeRef.trim());
  const restoredHealth: HealthResponse = JSON.parse(
    (await get(`${stack.dashboard}/api/health`)) ?? "null",
  );
  assert.equal(restoredHealth.version, sourceTag.slice(1));
  const restoredRun = await runWithSecret(hash);
  log(
    `printed restore command returned to ${sourceTag}; original secret still works in run ${restoredRun}`,
  );
  log("passed");
} catch (error) {
  if (stack !== undefined)
    process.stderr.write(await stack.compose("logs", "--no-color", "--tail=80").catch(() => ""));
  throw error;
} finally {
  await stack?.remove();
  await command("docker", ["rm", "--force", "--volumes", registry], source).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

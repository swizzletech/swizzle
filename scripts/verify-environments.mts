// `just verify-environments`: exercise both namespaces on one fresh packaged stack.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ApplyResponse,
  EnvironmentsResponse,
  RunResponse,
  RunsResponse,
} from "@swizzle/runtime/http-contract";
import { cleanUpOnSignal, get, startPackagedStack, until } from "./packaged-stack.mts";

const execute = promisify(execFile);
const evidence = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const log = (message: string) => process.stdout.write(`environments-check: ${message}\n`);
const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-environments-"));
const stack = await startPackagedStack("smoke", log);
let dashboard = stack.dashboard;
let tailnetPort: string | undefined;
const removeTailnet = async () => {
  if (tailnetPort) {
    await execute("tailscale", ["serve", `--https=${tailnetPort}`, "off"]);
    tailnetPort = undefined;
  }
};
cleanUpOnSignal(removeTailnet);
const browser = async (...args: string[]) =>
  execute("chrome-devtools-axi", args, {
    env: { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: "environments" },
    maxBuffer: 1024 * 1024,
  }).catch(() => {
    throw new Error(`Browser proof step ${args[0]} failed.`);
  });
async function api<T>(route: string): Promise<T> {
  const body = await get(`${dashboard}/api${route}`, stack.token);
  assert.ok(body, route);
  return JSON.parse(body);
}
async function record(name: string, value: unknown) {
  log(`${name}: ${JSON.stringify(value)}`);
  if (evidence)
    await writeFile(path.join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
try {
  if (evidence) await mkdir(evidence, { recursive: true });
  assert.equal(stack.environment, "production");
  if (process.env.SWIZZLE_VERIFY_TAILNET === "1") {
    const status = JSON.parse((await execute("tailscale", ["status", "--json"])).stdout) as {
      BackendState: string;
      Self: { DNSName: string };
    };
    assert.equal(status.BackendState, "Running");
    const hostname = status.Self.DNSName.replace(/\.$/u, "");
    const port = new URL(stack.dashboard).port;
    const serve = JSON.parse(
      (await execute("tailscale", ["serve", "status", "--json"])).stdout,
    ) as { TCP?: Record<string, unknown> };
    assert.equal(serve.TCP?.[port], undefined, "Proof must own its tailnet listener");
    dashboard = `https://${hostname}:${port}`;
    const env = (await readFile(stack.envFile, "utf8"))
      .replace(/^SWIZZLE_DASHBOARD_ORIGIN=.*$/mu, `SWIZZLE_DASHBOARD_ORIGIN=${dashboard}`)
      .replace(/^SWIZZLE_API_ORIGIN=.*$/mu, `SWIZZLE_API_ORIGIN=${dashboard}/api`)
      .replace(/^SWIZZLE_DASHBOARD_SITE=.*$/mu, `SWIZZLE_DASHBOARD_SITE=http://${hostname}:${port}`)
      .replace(/^SWIZZLE_API_SITE=.*$/mu, `SWIZZLE_API_SITE=http://api.localhost:${port}`);
    await writeFile(stack.envFile, env);
    await stack.compose("up", "-d", "--wait", "api", "caddy");
    await execute("tailscale", ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
    tailnetPort = port;
    await until(
      "private tailnet dashboard answers",
      async () =>
        (await get(dashboard))?.toLowerCase().includes("<!doctype html") ? true : undefined,
      log,
    );
    await stack.cli(
      "profile",
      "add",
      "smoke",
      "--url",
      `${dashboard}/api`,
      "--env",
      "production",
      "--token-env",
      "SWIZZLE_STACK_TOKEN",
      "--default",
    );
    log(`private install path: ${dashboard}`);
  }
  const environments = await api<EnvironmentsResponse>("/environments");
  assert.equal(environments.defaultEnvironment, "production");
  for (const name of ["staging", "production"]) {
    assert.ok(
      environments.environments
        .find((entry) => entry.name === name)
        ?.liveServices.includes("scheduler"),
    );
  }
  await record("fresh-environments", environments);
  await record("fresh-profile", JSON.parse(await stack.cli("profile", "list")));
  const password = /^SWIZZLE_SETUP_TOKEN=(.+)$/mu.exec(await readFile(stack.envFile, "utf8"))?.[1];
  assert.ok(password);
  if (evidence) {
    await browser("open", dashboard);
    await browser("resize", "1280", "720");
    await browser(
      "eval",
      `async () => {
      localStorage.clear();
      const response = await fetch('/api/auth/sign-in/email', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'smoke@swizzle.test', password: ${JSON.stringify(password)}})});
      if (!response.ok) throw new Error('Sign in failed');
      location.href = '/settings/agent-access';
      return 'Signed in';
    }`,
    );
    await browser("wait", "Agent access");
    await browser("wait", "Token name");
    const nameSnapshot = await browser("snapshot");
    const nameRef = /uid=(\S+) textbox "Token name"/u.exec(nameSnapshot.stdout)?.[1];
    assert.ok(nameRef, "Token name input");
    await browser("fill", `@${nameRef}`, "environment-proof");
    const createSnapshot = await browser("snapshot");
    const createRef = /uid=(\S+) button "Create agent token"/u.exec(createSnapshot.stdout)?.[1];
    assert.ok(createRef, "Create agent token button");
    await browser("click", `@${createRef}`);
    await browser("wait", "Give this to your agent");
    const state = await browser(
      "eval",
      `() => {
      const environment = document.querySelector('select[aria-label="Environment"]')?.value;
      const block = document.querySelector('[data-testid="give-to-agent"] pre');
      const command = block?.textContent.split('\\n').find(text => text.startsWith('swizzle profile add'));
      if (block) block.textContent = block.textContent.replace(/^export SWIZZLE_TOKEN=.*$/m, "export SWIZZLE_TOKEN='<redacted>'");
      if (environment !== 'production' || !command?.includes('--env production')) throw new Error(JSON.stringify({environment, command}));
      return {environment, command};
    }`,
    );
    log(state.stdout);
    await browser("screenshot", path.join(evidence, "fresh-agent-access.png"));
  }
  const cron = path.join(directory, "cron");
  await mkdir(cron);
  const config = `name: environment-cron
version: 1.0.0
entrypoint: main.js
trigger:
  type: cron
  every: 30s
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
secrets: []
api_check:
  mode: passive
`;
  await writeFile(path.join(cron, "config.yaml"), config);
  await writeFile(
    path.join(cron, "main.js"),
    "console.log(JSON.stringify({environment: process.env.SWIZZLE_ENV, trigger: process.env.SWIZZLE_TRIGGER_TYPE}));\n",
  );
  for (const environment of ["staging", "production"])
    await stack.cli("apply", cron, "-e", environment);
  for (const environment of ["staging", "production"]) {
    const runs = await until(
      `scheduled ${environment} run succeeds`,
      async () => {
        const runs = await api<RunsResponse>(
          `/dashboard/runs?environment=${environment}&automation=environment-cron`,
        );
        return runs.runs.some((run) => run.triggerType === "cron" && run.status === "succeeded")
          ? runs
          : undefined;
      },
      log,
    );
    const succeeded = runs.runs.find(
      (run) => run.triggerType === "cron" && run.status === "succeeded",
    );
    assert.ok(succeeded);
    const detail = await api<RunResponse>(`/runs/${succeeded.runId}?environment=${environment}`);
    assert.deepEqual(detail.result, { environment, trigger: "cron" });
    await record(`${environment}-cron-runs`, runs);
    if (evidence) {
      await browser("open", `${dashboard}/runs?automation=environment-cron`);
      await browser("wait", "Environment");
      const snapshot = await browser("snapshot");
      const environmentRef = /uid=(\S+) combobox "Environment"/u.exec(snapshot.stdout)?.[1];
      assert.ok(environmentRef, "Environment selector");
      await browser("fill", `@${environmentRef}`, environment);
      await browser("wait", "Succeeded");
      await browser("screenshot", path.join(evidence, `${environment}-cron-runs.png`));
    }
  }
  await record("scheduler-process", await stack.compose("ps", "--format", "json", "scheduler"));
  const webhook = path.join(directory, "webhook");
  await mkdir(webhook);
  await writeFile(
    path.join(webhook, "config.yaml"),
    config
      .replace("environment-cron", "environment-webhook")
      .replace("  type: cron\n  every: 30s", "  type: webhook\n  path: /environment-webhook"),
  );
  await writeFile(
    path.join(webhook, "main.js"),
    "console.log(JSON.stringify({environment: process.env.SWIZZLE_ENV}));\n",
  );
  const urls = new Map<string, string>();
  for (const environment of ["staging", "production"]) {
    const applied: ApplyResponse = JSON.parse(await stack.cli("apply", webhook, "-e", environment));
    assert.ok(applied.webhookUrl);
    urls.set(environment, applied.webhookUrl);
  }
  const stagingUrl = urls.get("staging");
  assert.ok(stagingUrl);
  const before = await api<RunsResponse>(
    "/dashboard/runs?environment=production&automation=environment-webhook",
  );
  const response = await fetch(stagingUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"test":true}',
  });
  assert.ok(response.ok);
  const { runId } = (await response.json()) as { runId: string };
  const run = await until(
    "staging webhook run succeeds",
    async () => {
      const run = await api<RunResponse>(`/runs/${runId}?environment=staging`);
      if (run.status === "failed" || run.status === "dead-lettered")
        throw new Error(JSON.stringify(run));
      return run.status === "succeeded" ? run : undefined;
    },
    log,
  );
  assert.equal(run.environment, "staging");
  assert.deepEqual(run.result, { environment: "staging" });
  const after = await api<RunsResponse>(
    "/dashboard/runs?environment=production&automation=environment-webhook",
  );
  assert.equal(before.runs.length, 0);
  assert.equal(after.runs.length, 0);
  await record("webhook-isolation", {
    url: stagingUrl,
    run,
    productionRunsBefore: before.runs,
    productionRunsAfter: after.runs,
  });
  log("passed");
} finally {
  await removeTailnet();
  if (evidence) await browser("stop").catch(() => {});
  await stack.remove();
  await rm(directory, { recursive: true, force: true });
}

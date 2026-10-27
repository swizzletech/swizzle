// A live named-service proof against the verify-swizzle stack and an authenticated local model.
// Run the skill's scripts/up, export its env plus SWIZZLE_LOCAL_LLM_{UPSTREAM,API_KEY,MODEL},
// then just verify-local-llm. Docker builds the production broker, proxy, gateway and runner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { FINISHED_RUN_STATUSES } from "@swizzle/db";
import { collectWorkerCapabilities } from "@swizzle/runtime";
import {
  localLlmHealth,
  type PlatformWorkerController,
  startPlatformWorkerService,
} from "@swizzle/runtime/platform";

const exec = promisify(execFile);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const apiUrl = process.env.VERIFY_API;
const ownerToken = process.env.VERIFY_TOKEN;
const scripts = process.env.V;
assert.ok(apiUrl && ownerToken && scripts, "Start verify-swizzle and source its env first.");
assert.ok(
  process.env.SWIZZLE_LOCAL_LLM_UPSTREAM &&
    process.env.SWIZZLE_LOCAL_LLM_API_KEY &&
    process.env.SWIZZLE_LOCAL_LLM_MODEL,
  "Configure an authenticated local LLM at a literal IP address first.",
);
const directory = await mkdtemp(path.join(os.tmpdir(), "swizzle-local-llm-proof-"));
const stack = `llm-proof-${randomUUID().slice(0, 8)}`;
const composeFile = path.join(directory, "compose.yml");
const execution = path.resolve("infra/docker/execution.yml");
const controlToken = randomBytes(32).toString("base64url");
const dockerEnvironment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: stack,
  SWIZZLE_LOCAL_LLM_CONTROL_TOKEN: controlToken,
};
// The production definitions, with no alternate policy for the verifier.
await writeFile(
  composeFile,
  JSON.stringify({
    services: Object.fromEntries(
      ["docker-broker", "runner-base", "runner-egress-proxy", "local-llm-gateway"].map((name) => [
        name,
        { extends: { file: execution, service: name } },
      ]),
    ),
    networks: {
      outbound: process.env.SWIZZLE_LOCAL_LLM_PROOF_NETWORK
        ? { external: true, name: process.env.SWIZZLE_LOCAL_LLM_PROOF_NETWORK }
        : {},
      "runner-control": { internal: true },
      "runner-egress": { internal: true },
    },
  }),
);
const docker = async (...args: string[]) =>
  (await exec("docker", args, { env: dockerEnvironment, maxBuffer: 16 * 1024 * 1024 })).stdout;
const compose = (...args: string[]) => docker("compose", "-p", stack, "-f", composeFile, ...args);
const call = async (method: string, route: string, body?: unknown, bearer = ownerToken) => {
  const response = await fetch(`${apiUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${JSON.stringify(value)}`);
  assert.ok(record(value));
  return value;
};
const workers: PlatformWorkerController[] = [];
const workerIds: string[] = [];
let ordinaryWorkerToken = "";
const automate = async (name: string, services: readonly string[]) => {
  const automation = path.join(directory, name);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(automation));
  await writeFile(
    path.join(automation, "config.yaml"),
    `name: ${name}\nversion: 1.0.0\nentrypoint: main.js\ntrigger:\n  type: webhook\n  path: /${name}\nruntime:\n  profile: ${stack}\n  timeout: 30s\n  permissions:\n    services: ${JSON.stringify(services)}\n`,
  );
  await writeFile(
    path.join(automation, "main.js"),
    `
import { spawnSync } from 'node:child_process';
const response = await fetch(process.env.SWIZZLE_LOCAL_LLM_URL ?? 'http://local-llm-inference:8080/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (process.env.SWIZZLE_LOCAL_LLM_TOKEN ?? 'absent') },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Say hello in one short sentence.' }], max_tokens: 32, temperature: 0 }),
});
const answer = await response.json();
const blocked = (url) => {
  const p = spawnSync('curl', ['--proxy', 'http://' + process.env.SWIZZLE_EGRESS_PROXY, '--proxytunnel', '--silent', '--show-error', '--max-time', '5', url], { env: { ...process.env, LD_PRELOAD: '' }, encoding: 'utf8' });
  return { code: p.status, error: p.stderr.trim() };
};
console.log(JSON.stringify({ status: response.status, answer: response.ok ? { model: answer.model, choices: answer.choices } : answer, privateAddress: blocked('http://192.168.12.34:80'), privatePort: blocked('http://local-llm-inference:8081') }));
`,
  );
  await exec(path.join(scripts, "swizzle"), ["apply", automation, "--json"], { env: process.env });
  return automation;
};
const start = async (services: readonly string[]) => {
  const projects = await call("GET", "/projects");
  assert.ok(Array.isArray(projects.projects));
  const project = projects.projects.find(
    (value: unknown) => record(value) && value.slug === "default",
  );
  assert.ok(record(project) && typeof project.id === "string");
  const enrollment = await call("POST", "/workers/enrollments", {
    name: `${stack}-${services.length ? "approved" : "ordinary"}`,
    profiles: [stack],
    services,
    environments: [{ projectId: project.id, environment: "staging" }],
  });
  assert.ok(typeof enrollment.code === "string");
  const credential = await call("POST", "/worker/enroll", { code: enrollment.code }, "");
  assert.ok(
    typeof credential.token === "string" &&
      record(credential.worker) &&
      typeof credential.worker.id === "string",
  );
  workerIds.push(credential.worker.id);
  if (services.length === 0) {
    ordinaryWorkerToken = credential.token;
    await call(
      "POST",
      "/worker/runtime",
      {
        capabilities: await collectWorkerCapabilities([]),
        services: { [LOCAL_LLM_SERVICE]: "healthy" },
        runImageDisk: null,
      },
      credential.token,
    );
    return;
  }
  const worker = await startPlatformWorkerService({
    apiUrl,
    credential: { kind: "configured", token: credential.token },
    concurrency: 1,
    environment: process.env,
    capabilities: await collectWorkerCapabilities([]),
    logger: {
      info() {},
      debug() {},
      warn(...args) {
        console.error(...args);
      },
      error(...args) {
        console.error(...args);
      },
    },
  });
  workers.push(worker);
};
const run = async (name: string) => {
  const result = await call("POST", `/automations/${name}/runs?environment=staging`, {
    input: {},
  });
  assert.ok(typeof result.runId === "string");
  return result.runId;
};
const waitRun = async (id: string) => {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const result = await call("GET", `/runs/${id}?environment=staging`);
    if (FINISHED_RUN_STATUSES.some((status) => status === result.status)) return result;
    await delay(200);
  }
  throw new Error(`Run ${id} did not finish.`);
};
try {
  console.log(`Building production execution services for ${stack}.`);
  await compose("build");
  await compose(
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    "docker-broker",
    "runner-egress-proxy",
    "local-llm-gateway",
  );
  const address = async (service: string, network: string) => {
    const id = (await compose("ps", "-q", service)).trim();
    return (
      await docker(
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${stack}_${network}").IPAddress}}`,
        id,
      )
    ).trim();
  };
  process.env.SWIZZLE_STACK = stack;
  process.env.SWIZZLE_REQUIRE_SANDBOX = "true";
  process.env.SWIZZLE_RUNNER_NETWORK = `${stack}_runner-egress`;
  process.env.SWIZZLE_RUNNER_BASE_IMAGE = `${stack}-runner-base`;
  process.env.SWIZZLE_RUNNER_EGRESS_PROXY = "http://runner-egress-proxy:3128";
  process.env.SWIZZLE_LOCAL_LLM_CONTROL_TOKEN = controlToken;
  process.env.SWIZZLE_LOCAL_LLM_CONTROL_URL = `http://${await address("local-llm-gateway", "runner-control")}:8081`;
  process.env.DOCKER_HOST = `tcp://${await address("docker-broker", "runner-control")}:2375`;
  const gatewayId = (await compose("ps", "-q", "local-llm-gateway")).trim();
  console.log(
    "Gateway health:",
    (
      await docker(
        "exec",
        gatewayId,
        "node",
        "-e",
        "fetch('http://local-llm-control:8081/health',{headers:{authorization:'Bearer '+process.env.SWIZZLE_LOCAL_LLM_CONTROL_TOKEN}}).then(r=>r.text()).then(console.log)",
      )
    ).trim(),
  );
  const health = await localLlmHealth(process.env);
  console.log("Worker observed local-llm health:", health);
  assert.equal(health, "healthy");
  await start([]);
  await automate(`${stack}-allowed`, [LOCAL_LLM_SERVICE]);
  const allowedId = await run(`${stack}-allowed`);
  const refused = await call("POST", "/worker/pull", {}, ordinaryWorkerToken);
  assert.equal(refused.assignment, null);
  const waiting = await call("GET", `/runs/${allowedId}?environment=staging`);
  assert.equal(
    waiting.status,
    "queued",
    "worker without the owner service grant must not claim it",
  );
  console.log("PASS owner service grant: ordinary worker leaves the authorized automation queued.");
  await start([LOCAL_LLM_SERVICE]);
  const allowed = await waitRun(allowedId);
  assert.equal(allowed.status, "succeeded", JSON.stringify(allowed));
  const output: unknown = JSON.parse(String(allowed.stdout));
  assert.ok(record(output) && record(output.answer) && Array.isArray(output.answer.choices));
  assert.equal(output.status, 200);
  const choice: unknown = output.answer.choices[0];
  assert.ok(
    record(choice) &&
      record(choice.message) &&
      typeof choice.message.content === "string" &&
      choice.message.content.trim().length > 0,
  );
  for (const key of ["privateAddress", "privatePort"]) {
    const denied: unknown = output[key];
    assert.ok(record(denied));
    assert.equal(denied.code, 56);
    assert.match(String(denied.error), /403/u);
  }
  console.log(`A1 PASS run=${allowedId} ${JSON.stringify(output)}`);
  await automate(`${stack}-denied`, []);
  const deniedId = await run(`${stack}-denied`);
  const denied = await waitRun(deniedId);
  assert.equal(denied.status, "succeeded", JSON.stringify(denied));
  const ordinary: unknown = JSON.parse(String(denied.stdout));
  assert.ok(record(ordinary));
  assert.equal(ordinary.status, 403);
  console.log(`A2 PASS run=${deniedId} ${JSON.stringify(ordinary)}`);
  console.log(
    "PASS production sandbox, broker, Squid, inference gateway and scoped HTTP worker protocol.",
  );
} finally {
  for (const worker of workers) await worker.close();
  for (const id of workerIds) await call("DELETE", `/workers/${id}`).catch(() => {});
  await compose("down", "--volumes", "--remove-orphans", "--rmi", "local").catch(() => {});
  const images = (
    await docker("image", "ls", "--quiet", "--filter", `label=swizzle.stack=${stack}`)
  )
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (images.length) await docker("image", "rm", ...new Set(images)).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}

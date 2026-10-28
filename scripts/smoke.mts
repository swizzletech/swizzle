// `just smoke`: proves the packaged stack end to end. It boots a throwaway packaged stack
// (scripts/packaged-stack.mts), deploys infra/examples/hello-webhook through the CLI (in process,
// from source), POSTs to its webhook on the public listener as an outside caller would, and waits for the run to
// succeed with HTTP server route, PostgreSQL, Valkey, automation.process and automation.complete spans in one trace.
// It then deploys the shipped skill's PDF recipe as written and runs it (scripts/smoke-recipe.mts).
// On exit it removes the stack with its volumes and images, so runs follow each other and run beside any other stack.

import assert from "node:assert/strict";
import { get, type PackagedStack, startPackagedStack, until } from "./packaged-stack.mts";
import { smokeRunnerEgress } from "./smoke-egress.mts";
import { smokePdfRecipe } from "./smoke-recipe.mts";
import { type SmokeTracing, startSmokeTracing } from "./smoke-tracing.mts";

const RUN_FAILED = new Set(["failed", "dead-lettered"]);

function log(message: string): void {
  process.stdout.write(`smoke: ${message}\n`);
}

async function smoke(stack: PackagedStack, tracing: SmokeTracing): Promise<void> {
  for (const host of [new URL(stack.api).host, new URL(stack.dashboard).host]) {
    for (const path of ["/", "/health", "/api/health", "/auth/sign-in/email", "/hello"]) {
      const response = await fetch(`${stack.links}${path}`, {
        headers: { host },
        method: path === "/auth/sign-in/email" || path === "/hello" ? "POST" : "GET",
      });
      assert.equal(response.status, 404, `public listener exposed ${host}${path}`);
      assert.equal(await response.text(), "", `public listener forwarded ${host}${path}`);
    }
    const approval = await fetch(`${stack.links}/approvals/invalid`, { headers: { host } });
    assert.equal(approval.status, 404);
    assert.match(await approval.text(), /This approval link is not available/u);
    // Under /hooks a sign-in path is a webhook lookup, never sign-in.
    const hook = await fetch(`${stack.links}/hooks/auth/sign-in/email`, {
      headers: { host },
      method: "POST",
    });
    assert.equal(hook.status, 404);
    assert.match(await hook.text(), /WEBHOOK_NOT_AVAILABLE/u);
  }
  log("public listener refuses dashboard and API routes and serves approvals and webhooks");
  await stack.cli("apply", "infra/examples/hello-webhook");
  log("deployed infra/examples/hello-webhook");
  // A sender outside the private network reaches the webhook through the public listener. The bare
  // URL names no environment, so the api serves it from its SWIZZLE_ENVIRONMENT.
  const response = await fetch(`${stack.links}/hooks/hello`, {
    body: '{"source":"smoke"}',
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `POST ${stack.links}/hooks/hello answered ${response.status}: ${await response.text()}`,
    );
  }
  const { runId } = (await response.json()) as { runId: string };
  log(`POST ${stack.links}/hooks/hello queued run ${runId}`);

  await until(
    `run ${runId} succeeded`,
    async () => {
      const body = await get(
        `${stack.dashboard}/api/runs/${runId}?environment=${stack.environment}`,
        stack.token,
      );
      const status =
        body === undefined ? undefined : (JSON.parse(body) as { status: string }).status;
      if (status !== undefined && RUN_FAILED.has(status)) {
        throw new Error(`Run ${runId} ended ${status}:\n${body}`);
      }
      return status === "succeeded" ? true : undefined;
    },
    log,
  );
  await tracing.assertWebhookTrace(runId);
  await smokePdfRecipe(stack, log);
  const workers = JSON.parse((await get(`${stack.api}/workers`, stack.token)) ?? "{}").workers as {
    id: string;
    kind: string;
    state: string;
  }[];
  const local = workers.find((worker) => worker.kind === "local");
  if (local === undefined || local.state !== "online")
    throw new Error("Configured local identity is not visible and online.");
  await stack.compose(
    "exec",
    "-T",
    "worker",
    "node",
    "--input-type=module",
    "-e",
    `
    const forbidden = ['DATABASE_URL', 'VALKEY_URL', 'SWIZZLE_ENCRYPTION_KEY', 'SWIZZLE_ARTIFACTS_DIR', 'SWIZZLE_ARTIFACT_S3_ACCESS_KEY_ID'];
    for (const name of forbidden) if (process.env[name]) throw new Error('Worker received ' + name);
    const response = await fetch('http://api:19820/worker/pull', { method: 'POST', headers: {authorization: 'Bearer ' + process.env.SWIZZLE_WORKER_TOKEN, 'content-type': 'application/json'}, body: '{}' });
    if (response.status !== 403) throw new Error('Public listener accepted local identity: ' + response.status);
    console.log('Local identity refused by public listener; infrastructure credentials absent.');
  `,
  );
  const revoked = await fetch(`${stack.api}/workers/${local.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${stack.token}` },
  });
  if (!revoked.ok) throw new Error("Owner could not disable local worker.");
  await stack.compose("restart", "api");
  await until(
    "local revocation survives API restart",
    async () => {
      const body = await get(`${stack.api}/workers`, stack.token);
      if (body === undefined) return undefined;
      const registered = JSON.parse(body).workers as { id: string; state: string }[];
      return registered.some((worker) => worker.id === local.id && worker.state === "revoked")
        ? true
        : undefined;
    },
    log,
  );
  log("local identity is visible, private, and remains disabled after API restart");
}

const tracing = await startSmokeTracing();
let stack: PackagedStack | undefined;
try {
  stack = await startPackagedStack("smoke", log, ".", {
    OTEL_EXPORTER_OTLP_ENDPOINT: tracing.endpoint,
  });
  await smokeRunnerEgress(stack, log);
  await smoke(stack, tracing);
  log("passed");
} catch (error) {
  process.exitCode = 1;
  if (stack !== undefined) {
    process.stdout.write(await stack.compose("logs", "--no-color", "--tail=200").catch(() => ""));
  }
  process.stderr.write(`smoke: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await stack?.remove();
  await tracing.close();
}

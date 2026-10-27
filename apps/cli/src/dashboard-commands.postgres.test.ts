import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testAccessStore, testEnvironmentStore } from "../../../test/stores.js";

import {
  buildTestServer,
  createBufferIO,
  createDashboardStub,
  createDeadApiUrl,
  createPlatformForStub,
  repoRoot,
  useCliTestEnvironment,
} from "../test/cli-harness.js";

import { runCli } from "./main.js";

// Commands that talk to an API instance, run against a real in-process API server with PostgreSQL stores.
useCliTestEnvironment();

describe("dashboard commands", () => {
  it.each(["ready", "not-ready"] as const)(
    "prints %s readiness in list and inspect",
    async (status) => {
      const dashboard = createDashboardStub("hello-webhook");
      const original = dashboard.listAutomations;
      dashboard.listAutomations = async (...args) =>
        (await original(...args)).map((automation) => ({
          ...automation,
          activeDeployment: {
            ...automation.activeDeployment,
            readiness: {
              ...automation.activeDeployment.readiness,
              status,
              errors:
                status === "ready"
                  ? []
                  : [{ code: "SECRET_MISSING", message: "Secret TOKEN is missing." }],
            },
          },
        }));
      const originalDetail = dashboard.getAutomationDetail;
      dashboard.getAutomationDetail = async (...args) => {
        const detail = await originalDetail(...args);
        const [automation] = await dashboard.listAutomations(args[1], args[2]);
        if (detail === null || automation === undefined)
          throw new Error("Fixture automation missing.");
        return { ...detail, activeDeployment: automation.activeDeployment };
      };
      const app = await buildTestServer({
        dashboard,
        platform: await createPlatformForStub("hello-webhook"),
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        const list = createBufferIO();
        expect(
          await runCli(
            ["list", "--fields", "name,status,notReady", "--json", "--api-url", address],
            list,
          ),
        ).toBe(0);
        expect(JSON.parse(list.stdoutText).automations).toEqual([
          {
            name: "hello-webhook",
            trigger: "webhook",
            lastRun: "never",
            status: status === "ready" ? "active" : "not-ready",
            notReady: status === "ready" ? null : "Secret TOKEN is missing.",
          },
        ]);
        const inspect = createBufferIO();
        expect(
          await runCli(["inspect", "hello-webhook", "--json", "--api-url", address], inspect),
        ).toBe(0);
        expect(JSON.parse(inspect.stdoutText).automation.ready).toBe(
          status === "ready" ? "yes" : "no: Secret TOKEN is missing.",
        );
      } finally {
        await app.close();
      }
    },
  );

  it("names the missing scheduler instead of a next run for an unserved cron trigger", async () => {
    const dashboard = createDashboardStub("cron-success", "cron");
    const servedDetail = dashboard.getAutomationDetail;
    dashboard.getAutomationDetail = async (...args) => {
      const detail = await servedDetail(...args);
      if (detail?.trigger == null) throw new Error("Fixture trigger missing.");
      return {
        ...detail,
        trigger: {
          ...detail.trigger,
          nextRunAt: "2026-04-18T22:05:00.000Z",
          schedulerServes: false,
        },
      };
    };
    const app = await buildTestServer({
      dashboard,
      platform: await createPlatformForStub("cron-success"),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const io = createBufferIO();
      expect(await runCli(["inspect", "cron-success", "--json", "--api-url", address], io)).toBe(0);
      const automation = JSON.parse(io.stdoutText).automation;
      expect(automation.scheduler).toBe("none serves local; this trigger starts no runs");
      expect(automation).not.toHaveProperty("nextRunAt");
    } finally {
      await app.close();
    }
  });

  it("renders inspect output from the live dashboard payload shape", async () => {
    const io = createBufferIO();
    const platform = await createPlatformForStub("hello-webhook");
    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const exitCode = await runCli(
        ["inspect", "hello-webhook", "--api-url", address, "--exact"],
        io,
      );

      expect(exitCode).toBe(0);
      expect(io.stdoutText).toBe(
        [
          "automation:",
          "  name: hello-webhook",
          "  title: hello-webhook",
          "  environment: local",
          '  deployment: "#1 v1.0.0 dep-active"',
          '  deployedAt: "2026-04-18T22:00:00.000Z"',
          "  runtime: typescript / host / host-default",
          "  trigger: webhook (active)",
          `  webhookUrl: "${new URL(address).origin}/hello?environment=local"`,
          "  ready: yes",
          "  secrets[2]{name,state}:",
          "    CLICKUP_TOKEN,bound",
          "    LEXOFFICE_API_KEY,missing",
          "  vars: none",
          "  timeoutGrant: none",
          '  recentRuns: "1 recent: 1 succeeded"',
          '  lastRun: "succeeded run-1 at 2026-04-18T22:00:00.000Z"',
          "  deployments: 1",
          'help[3]: "Run `swizzle secret set LEXOFFICE_API_KEY --value-env <VAR>`, then `swizzle apply <dir>`",Run `swizzle logs --run run-1` for the last run\'s logs,Run `swizzle trigger hello-webhook` to start a run',
          "",
        ].join("\n"),
      );
    } finally {
      await app.close();
    }
  });

  it("surfaces fuzzy resolution and warning in JSON inspect output", async () => {
    const io = createBufferIO();
    const platform = await createPlatformForStub("hello-webhook");
    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const exitCode = await runCli(["inspect", "hello", "--json", "--api-url", address], io);

      expect(exitCode).toBe(0);
      const output = JSON.parse(io.stdoutText);
      expect(output.automation.name).toBe("hello-webhook");
      expect(output.warnings).toEqual([
        'resolved "hello" -> "hello-webhook" (fuzzy match; pass --exact to disable)',
      ]);
      expect(io.stderrText).toBe("");
    } finally {
      await app.close();
    }
  });

  it("home lists every Needs-you kind with a fix that targets its project and environment", async () => {
    const accessStore = testAccessStore();
    const billing = await accessStore.createProject({ name: "Billing", slug: "billing" });
    const hello = { automationName: "hello-webhook", automationSlug: "hello-webhook" };
    const dashboard = createDashboardStub("hello-webhook");
    // Only the fields the home view reads; the API passes the overview through as it is.
    const overview = {
      environment: "local",
      last24h: { failed: 1 },
      needsYou: [
        { kind: "platform", problem: { code: "no-worker", queuedRuns: 2 } },
        {
          kind: "api-sunset",
          apiCheck: null,
          automation: hello,
          contact: { host: "api.example.com" },
        },
        {
          kind: "missing-secret",
          project: { id: billing.id, slug: billing.slug, name: billing.name },
          secretName: "STRIPE_KEY",
          state: "missing",
          usedBy: [hello],
        },
        {
          kind: "missing-connection",
          project: { id: billing.id, slug: billing.slug, name: billing.name },
          connectionName: "crm",
          provider: "google",
          status: "missing",
          usedBy: [hello],
        },
      ],
    };
    const app = await buildTestServer({
      dashboard: {
        ...dashboard,
        getOverview: (async () => overview) as unknown as typeof dashboard.getOverview,
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const io = createBufferIO();
      expect(await runCli(["--json", "--api-url", address], io)).toBe(0);
      const home = JSON.parse(io.stdoutText);
      expect(home.needsYou).toEqual([
        { kind: "platform no-worker", automation: "(instance)", next: "swizzle status -e local" },
        {
          kind: "API sunset api.example.com",
          automation: "hello-webhook",
          next: "swizzle inspect hello-webhook -e local",
        },
        {
          kind: "missing secret STRIPE_KEY",
          automation: "hello-webhook",
          next: "swizzle secret set STRIPE_KEY --value-env <VAR> --project billing -e local",
        },
        {
          kind: "missing connection crm",
          automation: "hello-webhook",
          next: "swizzle connections authorize crm --project billing -e local",
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("--exact disables fuzzy automation resolution", async () => {
    const io = createBufferIO();
    const platform = await createPlatformForStub("hello-webhook");
    const app = await buildTestServer({
      dashboard: createDashboardStub("hello-webhook"),
      platform,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      const exitCode = await runCli(
        ["inspect", "hello", "--exact", "--json", "--api-url", address],
        io,
      );

      expect(exitCode).toBe(6);
      expect(JSON.parse(io.stdoutText).code).toBe("AUTOMATION_NOT_FOUND");

      // A name one punctuation mark away is not rewritten into the visible slug.
      const punctuated = createBufferIO();
      expect(
        await runCli(
          ["inspect", "hello_webhook", "--exact", "--json", "--api-url", address],
          punctuated,
        ),
      ).toBe(6);
      expect(JSON.parse(punctuated.stdoutText)).toMatchObject({
        code: "AUTOMATION_NOT_FOUND",
        help: ["Run `swizzle list -e local`", expect.any(String)],
      });
    } finally {
      await app.close();
    }
  });

  it("status targets the instance environment and warns about an unserved namespace", async () => {
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
    const dashboard = createDashboardStub("hello-webhook");
    const environmentStore = await testEnvironmentStore([
      { name: "staging" },
      { name: "production" },
    ]);
    const app = await buildTestServer({
      environment: "staging",
      platform: await testPlatform(),
      dashboard: {
        ...dashboard,
        getOperationsSummary: async (environment) => ({
          ...(await dashboard.getOperationsSummary(environment)),
          environment,
        }),
      },
      environmentStore: {
        ...environmentStore,
        listEnvironments: async () =>
          (await environmentStore.listEnvironments()).map((entry) => ({
            ...entry,
            hasData: true,
            liveServices: entry.name === "production" ? ["scheduler"] : [],
          })),
      },
    });
    let environmentGets = 0;
    app.addHook("onRequest", async (request) => {
      if (request.method === "GET" && request.url === "/environments") environmentGets++;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const io = createBufferIO();
      expect(await runCli(["status", "-e", "staging", "--json", "--api-url", address], io)).toBe(0);
      expect(JSON.parse(io.stdoutText)).toMatchObject({
        environment: "staging",
        warnings: [
          'No live scheduler heartbeat for environment "staging" on this instance, so its cron triggers will not fire. Environments with a live scheduler: production. Deploy with -e production if that was the target.',
        ],
      });
      expect(environmentGets).toBe(1);
    } finally {
      await app.close();
    }
  });

  it.each(["apply", "status"])(
    "%s fails with a named error when environments cannot be reached",
    async (command) => {
      vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);
      const apiUrl = await createDeadApiUrl();
      for (const flags of [[], ["-e", "staging"]]) {
        const io = createBufferIO();
        const args =
          command === "apply" ? [path.join(repoRoot, "infra/examples/hello-webhook")] : [];
        expect(await runCli([command, ...args, ...flags, "--json", "--api-url", apiUrl], io)).toBe(
          5,
        );
        expect(JSON.parse(io.stdoutText)).toMatchObject({ code: "API_UNREACHABLE" });
      }
    },
  );
});

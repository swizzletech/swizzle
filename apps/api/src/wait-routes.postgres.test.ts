import { copyFile, writeFile } from "node:fs/promises";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { createDashboardStore, createPostgresWorkerRegistry } from "@swizzle/db/postgres";

import { createWaitLinkToken } from "@swizzle/runtime";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { testPlatform } from "../../../test/platform.js";

import { testDatabase } from "../../../test/postgres.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";

import { createAutomationFixture, deployFixture } from "../test/automations.js";

import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";

import { ownerHeaders, testPeople } from "../test/people.js";

import { buildTestServer } from "../test/server-harness.js";

import { createDashboardDataProvider, type DashboardDataProvider } from "./dashboard.js";

let owner: { readonly authorization: string };

beforeEach(async () => {
  owner = await ownerHeaders();
});

describe("wait routes", () => {
  it("maps authenticated event resolution responses to 200, 404, and 409", async () => {
    const stateDirectory = await temporaryDirectory("swizzle-api-");

    const platform = await testPlatform({
      artifactsDirectory: path.join(stateDirectory, "artifacts"),
    });
    const app = await buildTestServer({ platform });
    const automationDirectory = await createAutomationFixture({
      mainJs: [
        "const fs = require('node:fs');",
        "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
        "if (!Object.hasOwn(steps, 'api-event')) {",
        "  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'api-event' } } }) + '\\n');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ event: steps['api-event'] }));",
        "",
      ].join("\n"),
      name: "api-event-run",
      path: "/api-event-run",
    });

    await deployFixture(app, automationDirectory, {}, { headers: owner });
    const trigger = await app.inject({
      headers: owner,
      method: "POST",
      payload: {},
      url: "/api-event-run",
    });
    const runId = trigger.json().runId as string;
    expect((await platform.processNextPlatformRun())?.status).toBe("waiting");

    const missing = await app.inject({
      headers: owner,
      method: "POST",
      payload: { value: "late" },
      url: "/runs/00000000-0000-4000-8000-000000000000/events/api-event",
    });
    expect(missing.statusCode).toBe(404);

    const mismatch = await app.inject({
      headers: owner,
      method: "POST",
      payload: { value: "wrong" },
      url: `/runs/${runId}/events/other-event`,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: "RUN_EVENT_NOT_WAITING" });

    const resolved = await app.inject({
      headers: owner,
      method: "POST",
      payload: { value: { ok: true } },
      url: `/runs/${runId}/events/api-event`,
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ resumed: true, runId, stepKey: "api-event" });

    const succeeded = await platform.processNextPlatformRun();
    expect(succeeded?.result).toEqual({
      event: { timedOut: false, value: { ok: true } },
    });

    await app.close();
  });

  describe("public wait links", () => {
    const sdkRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
    // The longest step key a run may suspend on, in 3-byte UTF-8 characters: the longest token.
    const longestStep = `step-${"✓".repeat(250)}`;

    // A platform whose worker gives runs their links, and an API whose dashboard reads its store.
    async function linkedServer() {
      vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
      vi.stubEnv("SWIZZLE_LINK_URL", "https://links.example.com/");
      const platform = await testPlatform();
      const dashboard = {
        close: async () => undefined,
        getRunDetail: (runId: string) => platform.getPlatformRun(runId),
        listRunSteps: (runId: string) => platform.store.listRunSteps({ runId }),
      } as unknown as DashboardDataProvider;
      const app = await buildTestServer({ dashboard, platform });
      const start = async (automationDirectory: string, webhookPath: string) => {
        await deployFixture(app, automationDirectory, {}, { headers: owner });
        const trigger = await app.inject({
          headers: owner,
          method: "POST",
          payload: {},
          url: webhookPath,
        });
        const runId = trigger.json().runId as string;
        const suspended = await platform.processNextPlatformRun();
        expect(suspended?.status, suspended?.stderr).toBe("waiting");
        // The links as the SDK built them, which no API answer shows (the recipient gets them).
        const steps = await platform.store.listRunSteps({ runId });
        const links = steps.find((step) => step.stepKey === "links");
        const path = (url: string) => {
          expect(url.startsWith("https://links.example.com/")).toBe(true);
          return new URL(url).pathname;
        };
        return { links: links?.value as Record<string, string>, path, runId };
      };
      return { app, platform, start };
    }

    it("an approval link decides only its own step, once, and records who decided", async () => {
      const { app, platform, start } = await linkedServer();
      const automationDirectory = await createAutomationFixture({
        mainJs: [
          "(async () => {",
          "  const sdk = await import('./swizzle-sdk.ts');",
          `  const longest = ${JSON.stringify(longestStep)};`,
          "  const links = await sdk.runStep('links', () => ({ first: sdk.getApprovalUrl('first'), second: sdk.getApprovalUrl(longest) }));",
          "  const first = await sdk.requestApproval('first', { details: 'Refund 120 EUR?' });",
          "  const second = await sdk.requestApproval(longest);",
          "  console.log(JSON.stringify({ first, second }));",
          "})();",
          "",
        ].join("\n"),
        name: "api-approval-run",
        path: "/api-approval-run",
      });
      await copyFile(
        path.join(sdkRoot, "sdk-ts/src/index.ts"),
        path.join(automationDirectory, "swizzle-sdk.ts"),
      );
      const {
        links,
        path: linkPath,
        runId,
      } = await start(automationDirectory, "/api-approval-run");
      const first = linkPath(links.first as string);
      const second = linkPath(links.second as string);
      const decide = (url: string, decision: string, comment = "") =>
        app.inject({
          headers: { ...owner, "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
          payload: new URLSearchParams({ comment, decision }).toString(),
          url,
        });

      // Opening the page, however often, decides nothing.
      for (let index = 0; index < 2; index += 1) {
        const page = await app.inject({ headers: owner, method: "GET", url: first });
        expect(page.statusCode).toBe(200);
        expect(page.body).toContain("Refund 120 EUR?");
      }
      expect((await platform.getPlatformRun(runId)).status).toBe("waiting");

      expect((await app.inject({ headers: owner, method: "GET", url: second })).statusCode).toBe(
        409,
      );
      expect((await decide(second, "approve")).statusCode).toBe(409);
      expect((await decide(`${first.slice(0, -2)}xx`, "approve")).statusCode).toBe(404);

      const approved = await decide(first, "approve", "looks good");
      expect(approved.statusCode).toBe(200);
      expect(approved.body).toContain("Approved");
      expect((await decide(first, "reject")).statusCode).toBe(409);

      expect((await platform.processNextPlatformRun())?.wait?.stepKey).toBe(longestStep);
      expect((await decide(first, "reject")).statusCode).toBe(409);
      expect((await decide(second, "reject")).statusCode).toBe(200);

      const finished = await platform.processNextPlatformRun();
      expect(finished?.result).toEqual({
        first: {
          approved: true,
          assignee: null,
          comment: "looks good",
          decidedAt: expect.any(String),
          decidedBy: { kind: "link" },
          timedOut: false,
        },
        second: expect.objectContaining({
          approved: false,
          assignee: null,
          decidedBy: { kind: "link" },
        }),
      });
      const steps = await app.inject({
        headers: owner,
        method: "GET",
        url: `/dashboard/runs/${runId}/steps`,
      });
      const decisions = Object.fromEntries(
        steps
          .json()
          .map((step: { approval: unknown; stepKey: string }) => [step.stepKey, step.approval]),
      );
      const result = finished?.result as { first: unknown; second: unknown };
      expect(decisions).toEqual({ first: result.first, links: null, [longestStep]: result.second });

      await app.close();
    });

    // A link is a decision capability, so whoever may only read the run must not find it there:
    // not in its output, steps, approval details, state, or a child run's payload.
    it("a run viewer finds no link that decides, and the recipient's link still does", async () => {
      vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
      vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
      vi.stubEnv("SWIZZLE_LINK_URL", "https://links.example.com/");
      const people = testPeople();
      const platform = await testPlatform();
      const app = await buildTestServer({
        auth: people.auth,
        dashboard: createDashboardDataProvider({
          dashboardStore: createDashboardStore({ client: testDatabase() }),
          platform,
          workerRegistry: createPostgresWorkerRegistry({ client: testDatabase() }),
        }),
        platform,
      });
      const deploy = async (name: string, lines: readonly string[]) => {
        const directory = await createAutomationFixture({
          mainJs: [
            "(async () => {",
            "  const sdk = await import('./swizzle-sdk.ts');",
            ...lines,
            "})();",
            "",
          ].join("\n"),
          name,
          path: `/${name}`,
        });
        await copyFile(
          path.join(sdkRoot, "sdk-ts/src/index.ts"),
          path.join(directory, "swizzle-sdk.ts"),
        );
        await deployFixture(app, directory, {}, { headers: owner });
      };
      // The child reports whether it received the link itself, not a redacted copy.
      await deploy("api-link-child", [
        "  const payload = await sdk.readPayload();",
        "  console.log(JSON.stringify({ received: /\\/events\\/[0-9a-f-]{36}\\./.test(payload.link) }));",
      ]);
      await deploy("api-link-reader", [
        "  const links = await sdk.runStep('links', () => ({ gate: sdk.getApprovalUrl('gate'), hook: sdk.getEventCallbackUrl('hook') }));",
        "  console.error('links logged: ' + links.gate + ' ' + links.hook);",
        "  sdk.stateSet('link', links.hook);",
        "  const gate = await sdk.requestApproval('gate', { details: { link: links.hook } });",
        "  const child = await sdk.invokeAutomation('child', 'api-link-child', { link: links.hook });",
        "  const replayed = links.gate === sdk.getApprovalUrl('gate') && (await sdk.stateGet('link')) === links.hook;",
        "  console.log(JSON.stringify({ child: child.result, gate: gate.approved, links, replayed }));",
      ]);
      const trigger = await app.inject({
        headers: owner,
        method: "POST",
        payload: {},
        url: "/api-link-reader",
      });
      const runId = trigger.json().runId as string;
      expect((await platform.processNextPlatformRun())?.status).toBe("waiting");
      const gate = createWaitLinkToken({ kind: "approval", runId, stepKey: "gate" });
      const hook = createWaitLinkToken({ kind: "event", runId, stepKey: "hook" });

      const password = "a long enough test passphrase";
      await people.add("viewer@office.test", { password });
      const viewer = testBrowser(app);
      expect((await viewer.signIn("viewer@office.test", password)).statusCode).toBe(200);
      const share = await app.inject({
        headers: owner,
        method: "PUT",
        payload: { automation: "api-link-reader", role: "viewer", user: "viewer@office.test" },
        url: "/projects/default/grants",
      });
      expect(share.statusCode).toBe(200);
      const read = async () => {
        const urls = [
          `/runs/${runId}/logs`,
          `/dashboard/runs/${runId}/steps`,
          `/runs/${runId}`,
          `/dashboard/runs/${runId}`,
          "/dashboard/runs?automation=api-link-reader",
          "/automations/api-link-reader/state",
        ];
        const responses = await Promise.all(urls.map((url) => viewer.send("GET", url)));
        expect(responses.map((response) => response.statusCode)).toEqual(urls.map(() => 200));
        return responses.map((response) => response.body);
      };
      const waitingAt = async () => (await platform.getPlatformRun(runId)).wait?.stepKey;

      const seen = await read();
      expect(seen[0]).toContain("links logged: https://links.example.com/approvals/[REDACTED]");
      expect(JSON.parse(seen[1] as string)[0].value).toEqual({
        gate: "https://links.example.com/approvals/[REDACTED]",
        hook: "https://links.example.com/events/[REDACTED]",
      });
      expect(JSON.parse(seen[3] as string).approval.details).toEqual({
        link: "https://links.example.com/events/[REDACTED]",
      });
      expect(seen[5]).toContain('"https://links.example.com/events/[REDACTED]"');
      for (const body of seen) {
        expect(body).not.toContain(gate);
        expect(body).not.toContain(hook);
      }
      const signedIn = await viewer.send("POST", `/runs/${runId}/approvals/gate`, {
        approved: true,
      });
      expect([signedIn.statusCode, signedIn.json().code]).toEqual([403, "ACCESS_DENIED"]);
      const found = [...seen.join("\n").matchAll(/\/approvals\/([^"\s\\]+)/gu)];
      expect(new Set(found.map((match) => match[1]))).toEqual(new Set(["[REDACTED]"]));
      for (const [linkPath] of found) {
        const decided = await app.inject({
          headers: { "content-type": "application/x-www-form-urlencoded" },
          method: "POST",
          payload: "decision=approve",
          url: linkPath,
        });
        expect(decided.statusCode).toBe(404);
      }
      expect(await waitingAt()).toBe("gate");

      // The page shows the recipient this step's details, without another step's link.
      const page = await app.inject({ method: "GET", url: `/approvals/${gate}` });
      expect(page.body).toContain("https://links.example.com/events/[REDACTED]");
      expect(page.body).not.toContain(hook);

      // The recipient's comment carries a link too; the approval record shows it redacted.
      const approved = await app.inject({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
        payload: new URLSearchParams({
          comment: `see https://links.example.com/events/${hook}`,
          decision: "approve",
        }).toString(),
        url: `/approvals/${gate}`,
      });
      expect(approved.statusCode).toBe(200);
      expect((await platform.processNextPlatformRun())?.wait?.stepKey).toBe("child");
      const children = await app.inject({
        headers: owner,
        method: "GET",
        url: `/dashboard/runs?parentRunId=${runId}`,
      });
      const childId = children.json().runs[0].runId as string;
      const childRun = await app.inject({ headers: owner, method: "GET", url: `/runs/${childId}` });
      expect(childRun.json().payload).toEqual({
        link: "https://links.example.com/events/[REDACTED]",
      });
      expect((await platform.processNextPlatformRun())?.result).toEqual({ received: true });
      const finished = await platform.processNextPlatformRun();
      expect(finished?.result).toEqual({
        child: { received: true },
        gate: true,
        links: {
          gate: "https://links.example.com/approvals/[REDACTED]",
          hook: "https://links.example.com/events/[REDACTED]",
        },
        replayed: true,
      });
      const after = await read();
      const decision = JSON.parse(after[1] as string).find(
        (step: { stepKey: string }) => step.stepKey === "gate",
      );
      expect(decision.approval.comment).toBe("see https://links.example.com/events/[REDACTED]");
      for (const body of after) {
        expect(body).not.toContain(gate);
        expect(body).not.toContain(hook);
      }

      await app.close();
    });

    it("an event callback resumes the run with the posted body, once", async () => {
      const { app, platform, start } = await linkedServer();
      const automationDirectory = await temporaryDirectory("swizzle-api-event-callback-");
      await writeFile(
        path.join(automationDirectory, "config.yaml"),
        "name: api-event-callback\nversion: 1.0.0\nentrypoint: main.py\ntrigger:\n  type: webhook\n  path: /api-event-callback\n",
      );
      await writeFile(
        path.join(automationDirectory, "main.py"),
        [
          "import json",
          "import swizzle_sdk as sdk",
          `longest = ${JSON.stringify(longestStep)}`,
          "sdk.run_step('links', lambda: {'paid': sdk.get_event_callback_url(longest)})",
          "paid = sdk.wait_for_event(longest, timeout_ms=3_600_000)",
          "print(json.dumps({'paid': paid}))",
          "",
        ].join("\n"),
      );
      await copyFile(
        path.join(sdkRoot, "sdk-py/swizzle_sdk.py"),
        path.join(automationDirectory, "swizzle_sdk.py"),
      );
      const { links, path: linkPath } = await start(automationDirectory, "/api-event-callback");
      const callback = linkPath(links.paid as string);
      const post = (url: string, payload: string) =>
        app.inject({
          headers: { ...owner, "content-type": "application/json" },
          method: "POST",
          payload,
          url,
        });

      const forged = await post(`${callback.slice(0, -2)}xx`, "{}");
      expect(forged.statusCode).toBe(404);
      expect((await post(callback, JSON.stringify({ blob: "x".repeat(70_000) }))).statusCode).toBe(
        413,
      );

      const accepted = await post(callback, JSON.stringify({ amount: 12, currency: "EUR" }));
      expect(accepted.statusCode).toBe(200);
      const reused = await post(callback, JSON.stringify({ amount: 99 }));
      expect(reused.statusCode).toBe(404);
      expect(reused.body).toBe(forged.body);

      expect((await platform.processNextPlatformRun())?.result).toEqual({
        paid: { timedOut: false, value: { amount: 12, currency: "EUR" } },
      });

      await app.close();
    });
  });

  it("rate-limits public approval routes before token lookup", async () => {
    vi.stubEnv("SWIZZLE_APPROVAL_RATE_LIMIT", "1/min");
    const app = await buildTestServer({ platform: await testPlatform() });

    const first = await app.inject({
      headers: owner,
      method: "GET",
      remoteAddress: "203.0.113.10",
      url: "/approvals/not-a-token",
    });
    expect(first.statusCode).toBe(404);

    const second = await app.inject({
      headers: owner,
      method: "GET",
      remoteAddress: "203.0.113.10",
      url: "/approvals/not-a-token",
    });
    expect(second.statusCode).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();

    await app.close();
  });
});

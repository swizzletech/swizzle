import path from "node:path";
import { FULL_SCOPE, type InstanceRole } from "@swizzle/db";
import { createWaitLinkToken } from "@swizzle/runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testAccessStore, testApiTokenStore, testAuditStore } from "../../../test/stores.js";

import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";
import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { DASHBOARD_ORIGIN, testBrowser } from "../test/browser.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

beforeEach(() => {
  vi.stubEnv("SWIZZLE_DASHBOARD_ORIGIN", DASHBOARD_ORIGIN);
  vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("VALKEY_URL", "redis://127.0.0.1:1");
});

const PASSWORD = "a long enough test passphrase";

/** An approval step `gate` that the automation assigns to the team Finance. */
const ASKS_FINANCE = [
  "const fs = require('node:fs');",
  "const steps = JSON.parse(fs.readFileSync(process.env.SWIZZLE_STEPS_FILE, 'utf8'));",
  "if (!Object.hasOwn(steps, 'gate')) {",
  "  process.stdout.write(JSON.stringify({ $swizzle: { suspend: { reason: 'event', stepKey: 'gate', approval: true, assignee: { team: 'Finance' } } } }) + '\\n');",
  "  process.exit(0);",
  "}",
  "console.log(JSON.stringify(steps.gate));",
  "",
].join("\n");

/**
 * An instance whose owner is signed in, with the team Finance. People sign in from their own
 * address each, so no sign-in budget is shared; `token` acts as the owner without a session.
 */
async function office() {
  const stateDirectory = await temporaryDirectory("swizzle-approvals-");
  const accessStore = testAccessStore();
  const apiTokenStore = testApiTokenStore();
  const people = testPeople();
  const auditStore = testAuditStore();
  const platform = await testPlatform({
    auditStore,
    artifactsDirectory: path.join(stateDirectory, "artifacts"),
  });
  const app = await buildTestServer({
    accessStore,
    apiTokenStore,
    auditStore,
    auth: people.auth,
    platform,
  });
  onTestFinished(() => app.close());
  let address = 10;
  const signIn = async (email: string, role: InstanceRole = "member") => {
    const id = await people.add(email, { password: PASSWORD, role });
    const browser = testBrowser(app, `198.51.100.${address++}`);
    expect((await browser.signIn(email, PASSWORD)).statusCode).toBe(200);
    return { browser, email, id };
  };
  const owner = await signIn("owner@office.test", "owner");
  /** A personal token of the person: the same person, without a session. */
  const mint = async (userId: string) =>
    (
      await apiTokenStore.createToken({
        holder: { kind: "person", userId },
        issuedBy: { id: userId, name: "owner" },
        name: "cli",
        scope: FULL_SCOPE,
      })
    ).token;
  const ownerToken = await mint(owner.id);
  const asToken = (bearer: string) => ({
    send: (method: "DELETE" | "GET" | "POST" | "PUT", url: string, payload?: object) =>
      app.inject({
        headers: { authorization: `Bearer ${bearer}` },
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      }),
  });
  expect((await owner.browser.send("POST", "/teams", { name: "Finance" })).statusCode).toBe(201);
  const joinFinance = async (userId: string) =>
    expect(
      (await owner.browser.send("PUT", `/teams/Finance/members/${userId}`)).statusCode,
    ).toBeLessThan(300);
  return {
    app,
    asOwnerToken: asToken(ownerToken),
    auditStore,
    asToken,
    joinFinance,
    mint,
    owner,
    ownerToken,
    platform,
    signIn,
  };
}

describe("approvals, the audit and notifications over HTTP", { timeout: 60_000 }, () => {
  it("lets only the assignee decide, signed in, and an owner reassign with a reason", async () => {
    const {
      app,
      asOwnerToken,
      asToken,
      auditStore,
      joinFinance,
      mint,
      owner,
      ownerToken,
      platform,
      signIn,
    } = await office();
    const bo = await signIn("bo@office.test");
    const cy = await signIn("cy@office.test");
    await joinFinance(bo.id);
    for (const person of [bo, cy]) {
      await owner.browser.send("PUT", "/projects/default/grants", {
        role: "operator",
        user: person.email,
      });
    }
    const automation = await createAutomationFixture({
      mainJs: ASKS_FINANCE,
      name: "refund",
      path: "/refund",
    });
    const deployed = await deployFixture(
      app,
      automation,
      {},
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(deployed.statusCode).toBe(200);
    const { runId } = (await asOwnerToken.send("POST", "/automations/refund/runs", {})).json() as {
      runId: string;
    };
    expect((await platform.processNextPlatformRun())?.wait).toMatchObject({
      reason: "approval",
      assignee: {
        kind: "team",
        label: "Finance",
      },
    });
    const decide = `/runs/${runId}/approvals/gate`;

    // Cy may run the automation but is not in Finance; Bo's token is Bo, but no session.
    const notCy = await cy.browser.send("POST", decide, { approved: true });
    expect([notCy.statusCode, notCy.json().code]).toEqual([403, "APPROVAL_NOT_ASSIGNED"]);
    const boByToken = await asToken(await mint(bo.id)).send("POST", decide, { approved: true });
    expect([boByToken.statusCode, boByToken.json().code]).toEqual([403, "APPROVAL_NEEDS_SIGN_IN"]);
    const link = `/approvals/${createWaitLinkToken({ kind: "approval", runId, stepKey: "gate" })}`;
    const byLink = await app.inject({
      method: "POST",
      payload: { decision: "approve" },
      url: link,
    });
    expect(byLink.statusCode).toBe(403);
    const detail = await bo.browser.send("GET", `/dashboard/runs/${runId}`);
    expect(detail.json().approval).toMatchObject({
      assignee: { kind: "team", label: "Finance" },
      may: { decide: true, reassign: false },
    });

    // Bo cannot reassign; the owner hands it to Cy and says why.
    const byBo = await bo.browser.send("PUT", `${decide}/assignee`, {
      reason: "mine",
      user: bo.email,
    });
    expect(byBo.statusCode).toBe(403);
    const noReason = await owner.browser.send("PUT", `${decide}/assignee`, {
      reason: " ",
      user: cy.email,
    });
    expect(noReason.statusCode).toBe(400);
    // The reason and the run are in the event before the assignee changes, not only after it.
    const reassign = platform.reassignApproval.bind(platform);
    let atChange: unknown;
    vi.spyOn(platform, "reassignApproval").mockImplementationOnce(async (change) => {
      const [event] = await auditStore.list({ environments: null, limit: 1, projectIds: null });
      atChange = { details: event?.details, runId: event?.target.runId, status: event?.status };
      return await reassign(change);
    });
    const moved = await owner.browser.send("PUT", `${decide}/assignee`, {
      reason: "Bo is on leave",
      user: cy.email,
    });
    expect(atChange).toMatchObject({
      details: { reason: "Bo is on leave" },
      runId,
      status: null,
    });
    expect(moved.json()).toMatchObject({ assignee: { kind: "user", userId: cy.id } });

    const late = await bo.browser.send("POST", decide, { approved: false });
    expect([late.statusCode, late.json().code]).toEqual([403, "APPROVAL_NOT_ASSIGNED"]);
    const decided = await cy.browser.send("POST", decide, { approved: true, comment: "ok" });
    expect(decided.statusCode).toBe(200);
    expect((await platform.processNextPlatformRun())?.result).toEqual({
      approved: true,
      assignee: { kind: "user", label: cy.email, userId: cy.id },
      comment: "ok",
      decidedAt: expect.any(String),
      decidedBy: { kind: "person", label: cy.email, userId: cy.id },
      timedOut: false,
    });

    const events = (await owner.browser.send("GET", "/audit")).json().events as {
      action: string;
      actor: { kind: string; userId?: string };
      details: Record<string, unknown> | null;
      status: number;
      target: { runId: string | null };
    }[];
    expect(events.find((event) => event.action === "POST /approvals/:token")).toMatchObject({
      actor: { kind: "link" },
      status: 403,
      target: { runId },
    });
    expect(
      events.find(
        (event) =>
          event.action === "PUT /runs/:runId/approvals/:stepKey/assignee" && event.status === 200,
      ),
    ).toMatchObject({
      actor: { kind: "person", userId: owner.id },
      details: {
        from: { kind: "team", label: "Finance" },
        reason: "Bo is on leave",
        to: { kind: "user", userId: cy.id },
      },
    });
    expect(
      events
        .filter((event) => event.action === "POST /runs/:runId/approvals/:stepKey")
        .map((event) => [event.actor.userId, event.status]),
    ).toEqual([
      [cy.id, 200],
      [bo.id, 403],
      [bo.id, 403],
      [cy.id, 403],
    ]);
  });
  it("keeps a deleted automation's audit for owners, and shows each actor and token", async () => {
    const { app, asToken, owner, ownerToken, platform, signIn } = await office();
    const cy = await signIn("cy@office.test");
    // Refused before any handler runs: an instance route for a member, a body its schema rejects.
    expect((await cy.browser.send("POST", "/teams", { name: "Cy's" })).statusCode).toBe(403);
    const noDecision = await cy.browser.send("POST", "/runs/some-run/approvals/gate", {});
    expect(noDecision.statusCode).toBe(400);
    await owner.browser.send("PUT", "/projects/default/grants", {
      role: "operator",
      user: cy.email,
    });
    const automation = await createAutomationFixture({
      mainJs: "console.log(JSON.stringify({ ok: true }));\n",
      name: "ledger",
      path: "/ledger",
    });
    await deployFixture(
      app,
      automation,
      {},
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    await owner.browser.send("POST", "/projects/default/service-accounts", { name: "deployer" });
    await owner.browser.send("PUT", "/projects/default/grants", {
      role: "operator",
      serviceAccount: "deployer",
    });
    const minted = (
      await owner.browser.send("POST", "/projects/default/service-accounts/deployer/tokens", {
        name: "ci",
      })
    ).json() as { id: string; token: string };
    const deployer = asToken(minted.token);
    expect((await deployer.send("POST", "/automations/ledger/runs", {})).statusCode).toBe(200);
    expect((await cy.browser.send("POST", "/automations/ledger/runs", {})).statusCode).toBe(200);
    await platform.processNextPlatformRun();
    await platform.processNextPlatformRun();
    await owner.browser.send("POST", "/automations/ledger/trigger/pause");
    const triggerHistory = (
      await owner.browser.send("GET", "/automations/ledger/trigger/audit")
    ).json();
    expect(
      triggerHistory.map((event: { change: { eventType: string } }) => event.change.eventType),
    ).toEqual(["trigger_paused"]);
    expect(triggerHistory.at(-1)?.change).toMatchObject({
      automationSlug: "ledger",
      environment: "local",
      metadata: { status: "paused" },
      triggerType: "webhook",
    });
    const deploymentHistory = (
      await owner.browser.send("GET", "/automations/ledger/deployments/audit")
    ).json();
    expect(deploymentHistory).toMatchObject([
      {
        change: { kind: "deployment", eventType: "deploy", environment: "local", version: "1.0.0" },
        actor: { kind: "person", userId: owner.id, tokenId: expect.any(String) },
      },
    ]);
    const deleted = await owner.browser.send("DELETE", "/automations/ledger");
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().kept.auditEvents).toBe(5);

    const kept = (await owner.browser.send("GET", "/audit?automation=ledger")).json().events as {
      action: string;
      id: string;
      actor: Record<string, unknown>;
      target: { automationSlug: string | null; runId: string | null };
    }[];
    expect(kept.map((event) => [event.action, event.actor.kind])).toEqual([
      ["DELETE /automations/:automationName", "person"],
      ["POST /automations/:automationName/trigger/pause", "person"],
      ["POST /automations/:automationName/runs", "person"],
      ["POST /automations/:automationName/runs", "service-account"],
      ["POST /deployments", "person"],
    ]);
    expect(kept.find((event) => event.actor.kind === "service-account")?.actor).toEqual({
      kind: "service-account",
      label: "deployer",
      serviceAccountId: expect.any(String),
      tokenId: minted.id,
    });
    expect(triggerHistory[0]).toMatchObject({
      id: kept.find((event) => event.action.endsWith("/trigger/pause"))?.id,
      actor: { kind: "person" },
    });
    expect(deploymentHistory[0].id).toBe(kept.at(-1)?.id);

    // Cy administers nothing, so the audit shows Cy only what Cy did, refusals included.
    const own = (await cy.browser.send("GET", "/audit")).json().events as {
      action: string;
      actor: { userId?: string };
      status: number;
    }[];
    expect(new Set(own.map((event) => event.actor.userId))).toEqual(new Set([cy.id]));
    expect(own.map((event) => [event.action, event.status])).toEqual(
      expect.arrayContaining([
        ["POST /teams", 403],
        ["POST /runs/:runId/approvals/:stepKey", 400],
      ]),
    );

    // The owner's tokens read the audit only as far as their scope reaches.
    const scoped = async (name: string, scope: object) =>
      asToken(
        (await owner.browser.send("POST", "/auth/tokens", { name, scope })).json().token as string,
      );
    const viewer = await scoped("viewer", { role: "viewer" });
    const viewed = (await viewer.send("GET", "/audit?automation=ledger")).json().events as {
      actor: { userId?: string };
    }[];
    expect(viewed.length).toBeGreaterThan(0);
    expect(new Set(viewed.map((event) => event.actor.userId))).toEqual(new Set([owner.id]));
    const elsewhere = await scoped("staging", { environments: ["staging"] });
    const far = await elsewhere.send("GET", "/audit?environment=local");
    expect([far.statusCode, far.json()]).toEqual([200, { events: [], next: null }]);

    // The owner holds no grant on the project, so only the instance role allowed the rename.
    const folder = (
      await owner.browser.send("POST", "/automation-folders", { name: "Ops" })
    ).json();
    await owner.browser.send("PATCH", `/automation-folders/${folder.id}`, { name: "Ops 2" });
    const renamed = (await owner.browser.send("GET", "/audit?limit=1")).json().events;
    expect(renamed).toMatchObject([
      { action: "PATCH /automation-folders/:folderId", privileged: true },
    ]);
  });

  // Only writing requests create audit events: a read an owner's instance role alone allows
  // creates none, and neither does a dry run, which changes nothing. So an automation's change
  // history lists exactly its changes.
  it("shows a deploy as exactly its change in the automation's history", async () => {
    const { app, asOwnerToken, ownerToken } = await office();
    const automation = await createAutomationFixture({
      mainJs: "console.log(JSON.stringify({ ok: true }));\n",
      name: "ledger",
      path: "/ledger",
    });
    const deploy = (meta: { readonly dryRun?: boolean }) =>
      deployFixture(app, automation, meta, {
        headers: { authorization: `Bearer ${ownerToken}` },
      });
    const actions = async (query: string) =>
      (
        (await asOwnerToken.send("GET", `/audit?${query}`)).json().events as { action: string }[]
      ).map((event) => event.action);
    const before = await actions("limit=200");

    // `swizzle validate` before the first apply, the apply, and `swizzle apply --dry-run` after.
    expect((await deploy({ dryRun: true })).json()).toMatchObject({ action: "create" });
    expect((await deploy({})).statusCode).toBe(200);
    expect((await deploy({ dryRun: true })).json()).toMatchObject({ action: "noop" });
    expect((await asOwnerToken.send("GET", "/automations/ledger/deployments")).statusCode).toBe(
      200,
    );

    expect(await actions("automation=ledger&environment=local")).toEqual(["POST /deployments"]);
    expect(await actions("limit=200")).toEqual(["POST /deployments", ...before]);
  });

  it("counts and retains timeout changes in the same audit as the request", async () => {
    const { app, owner, ownerToken, platform } = await office();
    const automation = await createAutomationFixture({
      mainJs: "console.log(JSON.stringify({ ok: true }));\n",
      name: "timeout-audit",
      path: "/timeout-audit",
    });
    await deployFixture(
      app,
      automation,
      {},
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(
      (
        await owner.browser.send("PUT", "/automations/timeout-audit/timeout-grant", {
          maxTimeoutMs: 600_000,
          note: "Long export",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await owner.browser.send("DELETE", "/automations/timeout-audit/timeout-grant")).statusCode,
    ).toBe(200);
    await owner.browser.send("POST", "/automations/timeout-audit/trigger/pause");
    const audit = (await owner.browser.send("GET", "/audit?automation=timeout-audit")).json()
      .events;
    const deployment = await platform.store.getActiveDeploymentBySlug("timeout-audit", "local");
    const grants = await platform.store.listAutomationTimeoutGrantAuditEvents({
      automationId: deployment?.automationId ?? "missing",
      environment: "local",
    });
    expect(grants.map((event) => [event.change.eventType, event.change.metadata])).toEqual([
      ["timeout_grant_removed", { previousMaxTimeoutMs: 600_000 }],
      [
        "timeout_grant_set",
        { maxTimeoutMs: 600_000, note: "Long export", previousMaxTimeoutMs: null },
      ],
    ]);
    expect(grants.map((event) => event.id)).toEqual(
      audit
        .filter((event: { change: { kind: string } }) => event.change?.kind === "timeout-grant")
        .map((event: { id: string }) => event.id),
    );
    expect(grants[0]?.actor).toMatchObject({ kind: "person", userId: owner.id });
    const deleted = await owner.browser.send("DELETE", "/automations/timeout-audit");
    expect(deleted.json().kept.auditEvents).toBe(5);
    const kept = (await owner.browser.send("GET", "/audit?automation=timeout-audit")).json().events;
    expect(kept.map((event: { id: string }) => event.id).slice(1)).toEqual(
      audit.map((event: { id: string }) => event.id),
    );
  });

  it("stops a person's notifications once their access to the project is revoked", async () => {
    const { app, joinFinance, owner, ownerToken, platform, signIn } = await office();
    const bo = await signIn("bo@office.test");
    const cy = await signIn("cy@office.test");
    await joinFinance(bo.id);
    await owner.browser.send("PUT", "/projects/default/grants", {
      role: "viewer",
      team: "Finance",
    });
    for (const name of ["crash-a", "crash-b"]) {
      const automation = await createAutomationFixture({
        mainJs: "process.stdout.write('not json');\n",
        name,
        path: `/${name}`,
      });
      await deployFixture(
        app,
        automation,
        {},
        { headers: { authorization: `Bearer ${ownerToken}` } },
      );
    }

    // A rule reaches only what its person may read, and belongs to that person.
    const blind = await cy.browser.send("POST", "/notifications/rules", {
      automationName: "crash-a",
      chatId: "-1001",
      eventType: "dead-lettered",
    });
    expect([blind.statusCode, blind.json().code]).toEqual([404, "AUTOMATION_NOT_FOUND"]);
    const rule = await bo.browser.send("POST", "/notifications/rules", {
      chatId: "-1001",
      eventType: "dead-lettered",
    });
    expect(rule.json()).toMatchObject({ automationId: null, userId: bo.id });
    await owner.browser.send("POST", "/notifications/rules", {
      automationName: "crash-a",
      chatId: "-1002",
      eventType: "dead-lettered",
    });
    expect((await cy.browser.send("GET", "/notifications/rules")).json().rules).toEqual([]);
    expect(
      (await cy.browser.send("DELETE", `/notifications/rules/${rule.json().ruleId}`)).statusCode,
    ).toBe(404);

    const crash = async (name: string) => {
      await owner.browser.send("POST", `/automations/${name}/runs`, {});
      expect((await platform.processNextPlatformRun())?.status).toBe("dead-lettered");
    };
    await crash("crash-a");
    // A member reads the history of their own rules alone, for automations they read.
    const own = async (who: typeof bo) => {
      const answer = await who.browser.send("GET", "/notifications/deliveries");
      return [
        answer.statusCode,
        ((answer.json().deliveries ?? []) as { chatId: string; automationSlug: string }[])
          .map((delivery) => `${delivery.automationSlug} ${delivery.chatId}`)
          .toSorted(),
      ];
    };
    expect(await own(bo)).toEqual([200, ["crash-a -1001"]]);
    expect(await own(cy)).toEqual([200, []]);
    expect(
      (await owner.browser.send("DELETE", `/teams/Finance/members/${bo.id}`)).statusCode,
    ).toBeLessThan(300);
    await crash("crash-b");

    // No bot token is set, so a delivery Bo may receive stops there; Telegram is never called.
    const deliveries = (await owner.browser.send("GET", "/notifications/deliveries")).json()
      .deliveries as { automationSlug: string; metadata: { reason?: string }; status: string }[];
    expect(
      deliveries
        .map(
          (delivery) => `${delivery.automationSlug} ${delivery.status} ${delivery.metadata.reason}`,
        )
        .toSorted(),
    ).toEqual([
      "crash-a skipped missing-telegram-bot-token",
      "crash-a skipped missing-telegram-bot-token",
      "crash-b skipped access-revoked",
    ]);
    // Out of Finance, Bo reads neither automation, so neither delivery names it to him.
    expect(await own(bo)).toEqual([200, []]);
  });
});

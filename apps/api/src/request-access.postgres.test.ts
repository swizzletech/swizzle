import path from "node:path";
import {
  type DashboardRunsQuery,
  explainPlacement,
  RELEASE_TEAM_ID,
  type ReadScope,
} from "@swizzle/db";
import { type AutomationFolderStore, createPostgresWorkerRegistry } from "@swizzle/db/postgres";
import { ROUTE_ACCESS, type RouteAccess } from "@swizzle/runtime/http-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { testAccessStore, testApiTokenStore, testFolderStore } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory, waitFor } from "../../../test/support.js";
import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { ownerHeaders, testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";
import type { DashboardDataProvider } from "./dashboard.js";

beforeEach(() => {
  vi.stubEnv("VALKEY_URL", "redis://127.0.0.1:1");
});

afterEach(() => {
  vi.useRealTimers();
});

const ACCESS_NOT_FOUND = ["AUTOMATION_NOT_FOUND", "PROJECT_NOT_FOUND", "RUN_NOT_FOUND"];

/**
 * An office instance: project office holds report, project finance holds export, both deployed to
 * staging and production by the owner, each with a run in staging. Grants go through the API.
 */
async function office(options: { readonly automationFolderStore?: AutomationFolderStore } = {}) {
  const stateDirectory = await temporaryDirectory("swizzle-access-");
  const accessStore = testAccessStore();
  const platform = await testPlatform({
    artifactsDirectory: path.join(stateDirectory, "artifacts"),
  });
  const apiTokenStore = testApiTokenStore();
  const people = testPeople();
  const scopes: ReadScope[] = [];
  const runQueries: DashboardRunsQuery[] = [];
  // Mounts the worker routes; the office has no enrolled machines.
  const workerRegistry = createPostgresWorkerRegistry({ client: testDatabase() });
  vi.spyOn(workerRegistry, "list").mockResolvedValue([]);
  vi.spyOn(workerRegistry, "placement").mockImplementation(async (run) =>
    explainPlacement({ ...run, deadline: new Date(Date.now() + 60_000) }, []),
  );
  const app = await buildTestServer({
    accessStore,
    apiTokenStore,
    auth: people.auth,
    dashboard: recordingDashboard(scopes, runQueries),
    platform,
    workerRegistry,
    ...options,
  });
  const owner = await people.bearer(apiTokenStore, "owner@office.test", "owner");
  const as = (who: { readonly authorization: string }) => ({
    send: async (
      method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
      url: string,
      payload?: object,
    ) =>
      await app.inject({
        headers: { authorization: who.authorization },
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
      }),
  });
  const asOwner = as(owner);

  for (const [slug, name] of [
    ["office", "Office"],
    ["finance", "Finance"],
  ] as const) {
    expect((await asOwner.send("POST", "/projects", { name, slug })).statusCode).toBe(201);
  }
  const runs: Record<string, string> = {};
  for (const [automation, project] of [
    ["report", "office"],
    ["export", "finance"],
    ["ledger", "office"],
  ] as const) {
    const directory = await createAutomationFixture({
      mainJs: "console.log('{}');",
      name: automation,
      path: `/${automation}`,
    });
    for (const environment of ["staging", "production"]) {
      const deployed = await deployFixture(
        app,
        directory,
        { environment, project },
        { headers: { authorization: owner.authorization } },
      );
      expect(deployed.statusCode).toBe(200);
    }
    const run = await asOwner.send(
      "POST",
      `/automations/${automation}/runs?environment=staging`,
      {},
    );
    runs[automation] = run.json().runId as string;
  }

  return {
    accessStore,
    apiTokenStore,
    app,
    as,
    asOwner,
    owner,
    people,
    platform,
    runQueries,
    runs,
    scopes,
  };
}

/** A dashboard read model that records the scope each list is asked for, and each runs query. */
function recordingDashboard(
  scopes: ReadScope[],
  runQueries: DashboardRunsQuery[],
): DashboardDataProvider {
  const record = (scope: ReadScope) => {
    scopes.push(scope);
  };
  return {
    close: async () => {},
    // Only the refusals the route adds are under test; the read model has its own tests.
    getAutomationDetail: async () => ({ trigger: null }) as never,
    getAutomationReadme: async () => null,
    getAutomationSource: async () => null,
    getMermaidDiagram: async () => null,
    getOperabilitySummary: async () => {
      throw new Error("instance only");
    },
    getOperationsSummary: async () => {
      throw new Error("instance only");
    },
    getOverview: async (environment, scope) => {
      record(scope);
      return {
        environment,
        last24h: {} as never,
        complete: true,
        needsYou: [],
        recentChanges: [],
      };
    },
    getStepReach: async () => null,
    listAutomations: async (_environment, scope) => {
      record(scope);
      return [];
    },
    listRuns: async (query) => {
      record(query.scope);
      runQueries.push(query);
      return { environment: query.environment, filters: {} as never, runs: [] };
    },
    listRunSteps: async () => [],
  };
}

/** Each resource and instance route with its parameters filled for one automation and run. */
function probes(target: { automation: string; project: string; runId: string }) {
  const bodies: Record<string, object> = {
    "POST /automations/:automationName/rollback": { targetDeploymentId: "#1" },
    "POST /automations/:automationName/state": { key: "k", value: 1 },
    "POST /runs/:runId/approvals/:stepKey": { approved: true },
    "POST /runs/:runId/events/:stepKey": { value: 1 },
    "PUT /runs/:runId/approvals/:stepKey/assignee": { reason: "probe", team: "Probe" },
    "PUT /automations/:automationName/folder": { folderId: null },
    "PUT /automations/:automationName/project": { project: "office" },
    "PUT /credentials/:kind/:name/grants": { right: "use", user: "nobody@office.test" },
    "PUT /projects/:project/grants": { role: "viewer", user: "nobody@office.test" },
    "POST /projects/:project/service-accounts": { name: "probe" },
    "POST /projects/:project/service-accounts/:account/tokens": { name: "probe" },
  };
  return Object.entries(ROUTE_ACCESS)
    .filter(
      ([key, rule]) =>
        (rule === "resource" || rule === "instance") &&
        key !== "POST /deployments" &&
        /:(automationName|runId|project)\b|^\S+ \/credentials\//u.test(key),
    )
    .map(([key, rule]) => {
      const [method, template] = key.split(" ") as [string, string];
      const url = template
        .replace(":automationName", target.automation)
        .replace(":runId", target.runId)
        .replace(":project", target.project)
        .replace(":environment", "staging")
        .replace(":stepKey", "step")
        .replace(":account", "deployer")
        .replace(":identifier", "probe")
        .replace(":kind", "secret")
        .replace(":name", "EXPORT_TOKEN")
        .replace(":shareId", "00000000-0000-4000-8000-0000000000aa");
      const query = key.endsWith("/state") && method === "DELETE" ? "&key=k" : "";
      const grantQuery = key === "DELETE /projects/:project/grants" ? "&user=x" : "";
      // A credential route names its own project in the query; the path's project is a share's.
      const credentialQuery = template.startsWith("/credentials/")
        ? `&project=${target.project}`
        : "";
      return {
        key,
        method: method as "DELETE" | "GET" | "POST" | "PUT",
        payload: bodies[key] ?? (method === "POST" ? {} : undefined),
        rule: rule as RouteAccess,
        url: `${url}?environment=staging${query}${grantQuery}${credentialQuery}`,
      };
    });
}

describe("access over HTTP", () => {
  it("gives a person without a grant nothing of a project on any route, list or count", async () => {
    const { app, as, asOwner, people, apiTokenStore, runs, scopes } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    const asMia = as(mia);
    await asOwner.send("PUT", "/projects/office/grants", { role: "viewer", user: mia.userId });

    const hidden = probes({ automation: "export", project: "finance", runId: runs.export ?? "" });
    expect(hidden.length).toBeGreaterThan(30);
    for (const probe of hidden) {
      const response = await asMia.send(probe.method, probe.url, probe.payload);
      const outcome = { code: response.json().code, route: probe.key, status: response.statusCode };
      if (probe.rule === "instance") {
        expect(outcome).toEqual({ code: "ACCESS_DENIED", route: probe.key, status: 403 });
      } else {
        expect(outcome.status, probe.key).toBe(404);
        expect(ACCESS_NOT_FOUND, probe.key).toContain(outcome.code);
      }
    }

    // The same routes on the project Mia views reach past the policy: no access 404 anywhere.
    for (const probe of probes({
      automation: "report",
      project: "office",
      runId: runs.report ?? "",
    })) {
      // The open stream never ends for a reader; the revocation test below drives it.
      if (probe.rule === "instance" || probe.key.endsWith("/logs/stream")) continue;
      const response = await asMia.send(probe.method, probe.url, probe.payload);
      expect(ACCESS_NOT_FOUND, probe.key).not.toContain(response.json().code);
    }

    scopes.length = 0;
    for (const list of ["/dashboard/overview", "/dashboard/automations", "/dashboard/runs"]) {
      expect((await asMia.send("GET", `${list}?environment=staging`)).statusCode).toBe(200);
    }
    const officeProject = (await asOwner.send("GET", "/projects"))
      .json()
      .projects.find((project: { slug: string }) => project.slug === "office");
    expect(scopes).toEqual(
      Array(3).fill({ all: false, automations: [], projectIds: [officeProject.id] }),
    );
    expect((await asMia.send("GET", "/projects")).json().projects).toEqual([
      expect.objectContaining({ role: "viewer", slug: "office" }),
    ]);

    // Production is protected: a project grant alone allows nothing there, and says why.
    expect((await asMia.send("GET", "/automations/report?environment=production")).json()).toEqual(
      expect.objectContaining({
        code: "ACCESS_DENIED",
        details: expect.objectContaining({ required: "viewer", role: null }),
      }),
    );
    await app.close();
  });

  it("takes the highest of team and direct grants and applies a revocation on the next request", async () => {
    const { app, as, asOwner, people, apiTokenStore, runs } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    const asMia = as(mia);
    const team = (await asOwner.send("POST", "/teams", { name: "Ops" })).json();
    await asOwner.send("PUT", `/teams/${team.id}/members/${mia.userId}`);
    await asOwner.send("PUT", "/projects/office/grants", { role: "editor", team: "Ops" });
    await asOwner.send("PUT", "/projects/office/grants", { role: "viewer", user: mia.userId });

    const pause = "/automations/report/trigger/pause?environment=staging";
    expect((await asMia.send("POST", pause)).statusCode).toBe(200);

    await asOwner.send("DELETE", `/teams/${team.id}/members/${mia.userId}`);
    const denied = await asMia.send("POST", pause);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: "ACCESS_DENIED",
      details: {
        protectedEnvironment: null,
        required: "editor",
        role: "viewer",
        sources: [{ on: "project", role: "viewer", via: null }],
      },
    });

    await asOwner.send("DELETE", `/projects/office/grants?user=${mia.userId}`);
    expect((await asMia.send("GET", `/runs/${runs.report}`)).statusCode).toBe(404);

    // In production the team's editor role is capped by its environment grant.
    await asOwner.send("PUT", `/teams/${team.id}/members/${mia.userId}`);
    await asOwner.send("PUT", "/projects/office/grants", {
      environment: "production",
      role: "operator",
      team: "Ops",
    });
    const run = "/automations/report/runs?environment=production";
    expect((await asMia.send("POST", run, {})).statusCode).toBe(200);
    const pauseProduction = await asMia.send(
      "POST",
      "/automations/report/trigger/pause?environment=production",
    );
    expect(pauseProduction.json()).toMatchObject({
      code: "ACCESS_DENIED",
      details: { protectedEnvironment: "production", required: "editor", role: "operator" },
    });
    await app.close();
  });

  it("ends an open log stream once its reader's grant is revoked", async () => {
    const { app, asOwner, people, apiTokenStore, runs } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "viewer", user: mia.userId });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const response = await fetch(`${address}/runs/${runs.report}/logs/stream`, {
      headers: { authorization: mia.authorization },
    });
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("event: status");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(": keepalive\n\n");

    await asOwner.send("DELETE", `/projects/office/grants?user=${mia.userId}`);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await reader?.read())?.done).toBe(true);
    await app.close();
  });

  it("ends an open log stream once its reader is demoted", async () => {
    const { app, people, apiTokenStore, runs } = await office();
    const admin = await people.bearer(apiTokenStore, "ada@office.test", "admin");
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const response = await fetch(`${address}/runs/${runs.report}/logs/stream`, {
      headers: { authorization: admin.authorization },
    });
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toContain("event: status");

    await people.setRole(admin.userId, "member");
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await reader?.read())?.done).toBe(true);
    await app.close();
  });

  it("lists on Runs › Needs you only the approvals a person may be asked for", async () => {
    const { apiTokenStore, as, asOwner, people, runQueries } = await office();
    const sam = await people.bearer(apiTokenStore, "sam@office.test");
    await asOwner.send("PUT", "/projects/office/grants", {
      role: "operator",
      user: "sam@office.test",
    });

    await as(sam).send("GET", "/dashboard/runs?approvalOnly=true&environment=staging");
    await as(sam).send("GET", "/dashboard/runs?environment=staging");

    expect(runQueries.map((query) => query.assignedTo)).toEqual([
      [{ kind: "user", userId: sam.userId }],
      undefined,
    ]);
  });

  it("lets a direct share run one automation and read its runs, and nothing else of its project", async () => {
    const { app, as, asOwner, people, apiTokenStore, runs, scopes } = await office();
    const sam = await people.bearer(apiTokenStore, "sam@office.test");
    const asSam = as(sam);
    await asOwner.send("PUT", "/projects/office/grants", {
      automation: "report",
      role: "operator",
      user: "sam@office.test",
    });

    const run = await asSam.send("POST", "/automations/report/runs?environment=staging", {});
    expect(run.statusCode).toBe(200);
    const ran = await asSam.send("GET", `/runs/${run.json().runId}`);
    expect(ran.json()).toMatchObject({ automationSlug: "report", runId: run.json().runId });
    expect((await asSam.send("GET", `/runs/${runs.report}/logs`)).statusCode).toBe(200);

    expect((await asSam.send("GET", "/automations/ledger?environment=staging")).statusCode).toBe(
      404,
    );
    expect((await asSam.send("GET", `/runs/${runs.ledger}`)).statusCode).toBe(404);
    expect((await asSam.send("GET", "/projects")).json().projects).toEqual([]);
    expect((await asSam.send("GET", "/projects/office/access")).statusCode).toBe(404);
    expect((await asSam.send("GET", "/automations/report?environment=production")).statusCode).toBe(
      403,
    );

    scopes.length = 0;
    await asSam.send("GET", "/dashboard/automations?environment=staging");
    const report = await app.inject({
      headers: { authorization: sam.authorization },
      method: "GET",
      url: "/automations/report?environment=staging",
    });
    expect(scopes).toEqual([
      {
        all: false,
        automations: [
          { automationId: report.json().automationId, projectId: report.json().projectId },
        ],
        projectIds: [],
      },
    ]);
    await app.close();
  });

  it("places a deployment only where its deployer may edit", async () => {
    const { app, asOwner, people, apiTokenStore } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "editor", user: mia.userId });
    const deploy = async (name: string, meta: { environment: string; project?: string }) =>
      await deployFixture(
        app,
        await createAutomationFixture({ mainJs: "console.log('{}');", name, path: `/${name}` }),
        meta,
        { headers: { authorization: mia.authorization } },
      );

    expect((await deploy("digest", { environment: "staging", project: "office" })).statusCode).toBe(
      200,
    );
    expect((await deploy("digest", { environment: "staging" })).statusCode).toBe(200);
    expect((await deploy("memo", { environment: "staging" })).json()).toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    // Production caps Mia's editor role to nothing until a production grant names her.
    expect((await deploy("digest", { environment: "production" })).json()).toMatchObject({
      code: "ACCESS_DENIED",
    });
    expect((await deploy("export", { environment: "staging" })).json()).toMatchObject({
      code: "AUTOMATION_PROJECT_MISMATCH",
    });
    expect(
      (await deploy("report", { environment: "staging", project: "finance" })).json(),
    ).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await app.close();
  });

  it("keeps production to its grant on every path that changes it", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const { app, as, asOwner, people, apiTokenStore } = await office();
    const ed = await people.bearer(apiTokenStore, "ed@office.test");
    const rita = await people.bearer(apiTokenStore, "rita@office.test");
    // Office grants production to the team Release from its creation; nobody grants it here.
    const dev = (await asOwner.send("POST", "/teams", { name: "Dev" })).json();
    await asOwner.send("PUT", `/teams/${dev.id}/members/${ed.userId}`);
    await asOwner.send("PUT", `/teams/${RELEASE_TEAM_ID}/members/${rita.userId}`);
    for (const team of ["Dev", "Release"]) {
      await asOwner.send("PUT", "/projects/office/grants", { role: "editor", team });
    }
    const changed = await createAutomationFixture({
      mainJs: "console.log('{\"v\":2}');",
      name: "report",
      path: "/report",
    });
    const production = "environment=production&project=office";
    const attempts = (who: { readonly authorization: string }) => {
      const send = as(who).send;
      return {
        deploy: async () =>
          await deployFixture(
            app,
            changed,
            { environment: "production", project: "office" },
            { headers: { authorization: who.authorization } },
          ),
        rollback: async () => {
          const { deployments } = (
            await send("GET", "/automations/report/deployments?environment=production")
          ).json();
          // Ed cannot read production either, so his attempt names #1.
          const previous = (deployments ?? []).find(
            (entry: { status: string }) => entry.status !== "active",
          );
          return await send("POST", "/automations/report/rollback?environment=production", {
            targetDeploymentId: previous?.deploymentId ?? "#1",
          });
        },
        pause: async () =>
          await send("POST", "/automations/report/trigger/pause?environment=production"),
        resume: async () =>
          await send("POST", "/automations/report/trigger/resume?environment=production"),
        setSecret: async () =>
          await send("PUT", `/secrets/REPORT_TOKEN?${production}`, { value: "release-value" }),
        deleteSecret: async () => await send("DELETE", `/secrets/REPORT_TOKEN?${production}`),
      };
    };
    const outcomes = async (who: { readonly authorization: string }) => {
      const result: Record<string, number> = {};
      for (const [name, attempt] of Object.entries(attempts(who))) {
        result[name] = (await attempt()).statusCode;
      }
      return result;
    };

    expect(await outcomes(ed)).toEqual({
      deleteSecret: 403,
      deploy: 403,
      pause: 403,
      resume: 403,
      rollback: 403,
      setSecret: 403,
    });
    expect((await as(ed).send("DELETE", "/automations/report")).statusCode).toBe(403);
    expect(await outcomes(rita)).toEqual({
      deleteSecret: 204,
      deploy: 200,
      pause: 200,
      resume: 200,
      rollback: 200,
      setSecret: 200,
    });
    // Staging is not protected: there the Dev editor changes what Release changes in production.
    expect(
      (await as(ed).send("POST", "/automations/report/trigger/pause?environment=staging"))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await as(ed).send("PUT", "/secrets/REPORT_TOKEN?environment=staging&project=office", {
          value: "dev-value",
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  it("lets a project editor change production only through a production grant, which Release holds by default", async () => {
    const { app, as, asOwner, people, apiTokenStore } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    for (const project of ["office", "finance"]) {
      await asOwner.send("PUT", `/projects/${project}/grants`, {
        role: "editor",
        user: mia.userId,
      });
    }
    const pause = (project: string) =>
      as(mia).send(
        "POST",
        `/automations/${project === "office" ? "report" : "export"}/trigger/pause?environment=production`,
      );

    const refused = await pause("office");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe(
      "This needs editor; you have no role here. The production environment is protected in this project, so only a production grant counts there. Ask an admin of the project to grant you production, or an owner or admin of the instance to add you to a team that holds it.",
    );

    await asOwner.send("PUT", `/teams/${RELEASE_TEAM_ID}/members/${mia.userId}`);
    expect((await pause("office")).statusCode).toBe(200);

    await asOwner.send("DELETE", "/projects/office/grants?team=Release&environment=production");
    expect((await pause("office")).statusCode).toBe(403);
    expect((await pause("finance")).statusCode).toBe(200);
    await app.close();
  });

  it("names the target of a refused change in the audit, unless the target is hidden", async ({
    signal,
  }) => {
    const { app, as, asOwner, people, apiTokenStore } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "operator", user: mia.userId });

    expect(
      (await as(mia).send("POST", "/automations/report/trigger/pause?environment=staging"))
        .statusCode,
    ).toBe(403);
    expect(
      (await as(mia).send("POST", "/automations/export/trigger/pause?environment=staging"))
        .statusCode,
    ).toBe(404);
    // A refused grant keeps the place it named, as the request named it.
    for (const place of [{ environment: "staging" }, { automation: "report" }]) {
      const grant = { ...place, role: "viewer", user: mia.userId };
      expect((await as(mia).send("PUT", "/projects/office/grants", grant)).statusCode).toBe(403);
    }
    const audit = async () =>
      (await asOwner.send("GET", `/audit?actor=${mia.userId}`)).json().events as {
        action: string;
        status: number | null;
        target: { automationSlug: string | null; environment: string | null };
      }[];
    // The audit completes an event after the reply, so the four refusals land in their own time.
    let events: Awaited<ReturnType<typeof audit>> = [];
    await waitFor(signal, async () => {
      events = await audit();
      return events.length === 4 && events.every(({ status }) => status !== null);
    });
    expect(
      events.map(({ status, target }) => [status, target.automationSlug, target.environment]),
    ).toEqual([
      [403, "report", null],
      [403, null, "staging"],
      [404, null, null],
      [403, "report", "staging"],
    ]);
    await app.close();
  });

  it("checks a deployment in a dry run as apply would, and deploys nothing", async () => {
    const { app, asOwner, people, apiTokenStore } = await office();
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "editor", user: mia.userId });
    const dryRun = async (
      name: string,
      meta: { environment: string; project?: string },
      path = `/${name}`,
    ) => {
      const directory = await createAutomationFixture({ mainJs: "console.log('{}');", name, path });
      const answer = await deployFixture(
        app,
        directory,
        { ...meta, dryRun: true },
        { headers: { authorization: mia.authorization } },
      );
      const body = answer.json();
      return [answer.statusCode, answer.statusCode === 200 ? body.projectId : body.code];
    };
    const officeId = (await asOwner.send("GET", "/projects"))
      .json()
      .projects.find((project: { slug: string }) => project.slug === "office").id;

    expect(await dryRun("report", { environment: "staging" })).toEqual([200, officeId]);
    expect(await dryRun("memo", { environment: "staging", project: "office" })).toEqual([
      200,
      officeId,
    ]);
    expect(await dryRun("report", { environment: "production" })).toEqual([403, "ACCESS_DENIED"]);
    expect(await dryRun("memo", { environment: "staging" })).toEqual([404, "PROJECT_NOT_FOUND"]);
    expect(await dryRun("export", { environment: "staging" })).toEqual([
      409,
      "AUTOMATION_PROJECT_MISMATCH",
    ]);
    expect(await dryRun("memo", { environment: "staging", project: "office" }, "/ledger")).toEqual([
      409,
      "TRIGGER_WEBHOOK_PATH_CONFLICT",
    ]);
    expect(
      (await asOwner.send("GET", "/automations/memo/deployments?environment=staging")).statusCode,
    ).toBe(404);
    await app.close();
  });

  it("files folders by project: an editor manages their own project's and is refused another's", async () => {
    const automationFolderStore = await testFolderStore();
    const { app, as, asOwner, people, apiTokenStore } = await office({ automationFolderStore });
    const projectIds = Object.fromEntries(
      (await asOwner.send("GET", "/projects"))
        .json()
        .projects.map((project: { id: string; slug: string }) => [project.slug, project.id]),
    );
    const mia = await people.bearer(apiTokenStore, "mia@office.test");
    const asMia = as(mia);
    await asOwner.send("PUT", "/projects/office/grants", { role: "editor", user: mia.userId });
    await asOwner.send("PUT", "/projects/finance/grants", { role: "viewer", user: mia.userId });
    const theirs = (
      await asOwner.send("POST", "/automation-folders", { name: "Ledgers", project: "finance" })
    ).json();

    const mine = await asMia.send("POST", "/automation-folders", {
      name: "Reports",
      project: "office",
    });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().projectId).toBe(projectIds.office);
    const folder = `/automation-folders/${mine.json().id}`;
    expect((await asMia.send("PATCH", folder, { name: "Monthly" })).statusCode).toBe(200);
    expect(
      (await asMia.send("PUT", "/automations/report/folder", { folderId: mine.json().id }))
        .statusCode,
    ).toBe(200);
    expect(
      (await asMia.send("GET", "/automation-folders"))
        .json()
        .folders.map((entry: { name: string }) => entry.name),
    ).toEqual(["Ledgers", "Monthly"]);

    const refused = {
      assign: await asMia.send("PUT", "/automations/report/folder", { folderId: theirs.id }),
      create: await asMia.send("POST", "/automation-folders", { name: "Mine", project: "finance" }),
      delete: await asMia.send("DELETE", `/automation-folders/${theirs.id}`),
      rename: await asMia.send("PATCH", `/automation-folders/${theirs.id}`, { name: "Mine" }),
    };
    for (const [action, response] of Object.entries(refused)) {
      expect({ action, code: response.json().code, status: response.statusCode }).toEqual({
        action,
        code: "ACCESS_DENIED",
        status: 403,
      });
    }
    // Without any role in finance its folders do not exist for her.
    await asOwner.send("DELETE", `/projects/finance/grants?user=${mia.userId}`);
    const hidden = await asMia.send("PATCH", `/automation-folders/${theirs.id}`, { name: "Mine" });
    expect({ code: hidden.json().code, status: hidden.statusCode }).toEqual({
      code: "FOLDER_NOT_FOUND",
      status: 404,
    });
    expect(
      (await asMia.send("GET", "/automation-folders"))
        .json()
        .folders.map((entry: { name: string }) => entry.name),
    ).toEqual(["Monthly"]);
    await app.close();
  });

  it("keeps runs in their project when the automation moves and deletes them with it", async () => {
    const { app, as, asOwner, owner, people, apiTokenStore, platform, runs } = await office();
    const olga = await people.bearer(apiTokenStore, "olga@office.test");
    const fin = await people.bearer(apiTokenStore, "fin@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "admin", user: olga.userId });
    await asOwner.send("PUT", "/projects/finance/grants", { role: "viewer", user: olga.userId });
    await asOwner.send("PUT", "/projects/finance/grants", { role: "editor", user: fin.userId });
    const asOlga = as(olga);
    const asFin = as(fin);
    const move = async (who: typeof asOwner) =>
      await who.send("PUT", "/automations/report/project", { project: "finance" });

    // Moving needs admin in both projects, and no active trigger anywhere.
    expect((await move(asOlga)).json()).toMatchObject({ code: "ACCESS_DENIED" });
    expect((await move(asOwner)).json()).toMatchObject({ code: "AUTOMATION_NOT_PAUSED" });
    for (const environment of ["staging", "production"]) {
      await asOwner.send("POST", `/automations/report/trigger/pause?environment=${environment}`);
    }
    expect((await move(asOwner)).statusCode).toBe(200);

    // The run written in office stays readable there, and only there. The automation's audit
    // starts over in finance: the deploy event from office stays in office's history.
    expect((await asOlga.send("GET", `/runs/${runs.report}`)).statusCode).toBe(200);
    expect((await asFin.send("GET", `/runs/${runs.report}`)).statusCode).toBe(404);
    // Its panel decides Cancel where the run is and Run again where the automation is now.
    const panel = (await asOlga.send("GET", `/dashboard/runs/${runs.report}`)).json();
    expect(panel.refusals).toMatchObject({
      cancel: null,
      runAgain: { required: "operator", role: "viewer" },
    });
    const audit = "/automations/report/deployments/audit?environment=staging";
    expect((await asFin.send("GET", audit)).json()).toEqual([]);
    expect((await asOwner.send("GET", audit)).json()).toEqual([]);
    const later = (
      await asOwner.send("POST", "/automations/report/runs?environment=staging", {})
    ).json().runId;
    expect((await asFin.send("GET", `/runs/${later}`)).statusCode).toBe(200);

    // A reader of office alone still diagnoses the office run, without finance's deployments.
    const vic = await people.bearer(apiTokenStore, "vic@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "viewer", user: vic.userId });
    const redeployed = await deployFixture(
      app,
      await createAutomationFixture({
        mainJs: "console.log('{\"v\":2}');",
        name: "report",
        path: "/report",
      }),
      { environment: "staging", project: "finance" },
      { headers: { authorization: owner.authorization } },
    );
    const diagnosis = await as(vic).send("GET", `/runs/${runs.report}/diagnosis`);
    expect(diagnosis.statusCode).toBe(200);
    expect(diagnosis.body).not.toContain(redeployed.json().deploymentId);

    // Delete waits for unfinished runs; these finish here.
    while ((await platform.processNextPlatformRun()) !== null) {}
    const deleted = await asOwner.send("DELETE", "/automations/report");
    expect(deleted.json()).toMatchObject({ deletedCounts: { runs: 2 } });
    expect((await asOwner.send("GET", `/runs/${runs.report}`)).statusCode).toBe(404);
    expect((await asOwner.send("GET", `/runs/${later}`)).statusCode).toBe(404);
    await app.close();
  });

  it("deletes a project only once told where its automations, credentials and runs go", async () => {
    const { app, as, asOwner, people, apiTokenStore, platform } = await office();
    const olga = await people.bearer(apiTokenStore, "olga@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "admin", user: olga.userId });
    await asOwner.send("PUT", "/projects/finance/grants", { role: "viewer", user: olga.userId });
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const secret = (project: string) => `/secrets/SMTP?project=${project}&environment=staging`;
    await asOwner.send("PUT", secret("office"), { value: "office" });
    await asOwner.send("PUT", secret("finance"), { value: "finance" });
    const counts = (await asOwner.send("GET", "/projects/office/contents")).json();
    expect(counts).toMatchObject({ automations: 2, credentials: 1 });

    expect((await asOwner.send("DELETE", "/projects/office")).json()).toMatchObject({
      code: "PROJECT_NOT_EMPTY",
      details: counts,
    });
    for (const query of ["?contents=move", "?contents=delete&to=finance", "?to=finance"]) {
      expect((await asOwner.send("DELETE", `/projects/office${query}`)).statusCode).toBe(400);
    }
    // Moving needs admin in the target too.
    expect(
      (await as(olga).send("DELETE", "/projects/office?contents=move&to=finance")).json(),
    ).toMatchObject({ code: "ACCESS_DENIED" });

    // A name both projects use refuses the move before anything moves.
    expect(
      (await asOwner.send("DELETE", "/projects/office?contents=move&to=finance")).json(),
    ).toMatchObject({
      code: "CREDENTIAL_NAME_CONFLICT",
      details: { conflicts: [{ environment: "staging", name: "SMTP" }] },
    });
    expect((await asOwner.send("GET", "/projects/office/contents")).json()).toEqual(counts);
    await asOwner.send("DELETE", secret("finance"));
    const moved = await asOwner.send("DELETE", "/projects/office?contents=move&to=finance");
    expect(moved.json()).toMatchObject({ contents: "move", counts });
    const projects = (await asOwner.send("GET", "/projects")).json().projects;
    expect(projects.map((project: { slug: string }) => project.slug)).not.toContain("office");
    expect((await asOwner.send("GET", "/projects/office/access")).statusCode).toBe(404);
    const finance = projects.find((project: { slug: string }) => project.slug === "finance");
    expect((await platform.findAutomation("report"))?.projectId).toBe(finance.id);
    // The short name is free again.
    expect(
      (await asOwner.send("POST", "/projects", { name: "Office", slug: "office" })).statusCode,
    ).toBe(201);
    const events = (await asOwner.send("GET", "/audit?limit=50")).json().events;
    expect(
      events.find(
        (event: { action: string; status: number }) =>
          event.action === "DELETE /projects/:project" && event.status === 200,
      )?.details,
    ).toEqual({ contents: "move", to: finance.id });
    await app.close();
  });

  it("tells the dashboard which controls a role refuses, and why", async () => {
    const { app, as, asOwner, people, apiTokenStore } = await office();
    const ed = await people.bearer(apiTokenStore, "ed@office.test");
    await asOwner.send("PUT", "/projects/office/grants", { role: "operator", user: ed.userId });
    const operator = {
      protectedEnvironment: null,
      required: "editor",
      role: "operator",
      scope: null,
      sources: [{ on: "project", role: "operator", via: null }],
    };

    const detail = await as(ed).send("GET", "/dashboard/automations/report?environment=staging");
    expect(detail.json().refusals).toMatchObject({ edit: operator, organize: operator, run: null });
    const folders = (await as(ed).send("GET", "/automation-folders")).json();
    expect(folders.create).toMatchObject({ required: "editor", role: null, sources: [] });
    await app.close();
  });

  it("refuses a route without an access rule and a resource route that never asks", async () => {
    const { app } = await office();
    await app.close();
    const fresh = await buildTestServer();
    expect(() => fresh.get("/unlisted", async () => ({}))).toThrow(/no entry in ROUTE_ACCESS/u);

    const table = ROUTE_ACCESS as Record<string, RouteAccess>;
    table["GET /unchecked"] = "resource";
    try {
      const unchecked = await buildTestServer();
      unchecked.get("/unchecked", async () => ({ secret: true }));
      const response = await unchecked.inject({
        headers: await ownerHeaders(),
        method: "GET",
        url: "/unchecked",
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("secret");
      await unchecked.close();
    } finally {
      delete table["GET /unchecked"];
    }
    await fresh.close();
  });
});

import { CodedError } from "@swizzle/db";
import { it } from "vitest";
import { testDatabase, untilLockWaiters } from "../test/postgres.js";
import { testControlPlaneStore } from "../test/stores.js";
// The ADR 0014 access model on PostgreSQL: grants
// reach a person directly and through teams, a revocation shows on the next read, deletes cascade
// to the grants they orphan, an automation keeps its project when deployed, runs stay in the
// project they were written in across a move, deleting the automation deletes its runs while its
// audit events stay, secrets are per project,
// every project grants production to the team Release, every dashboard list and count filters by
// the reader's scope in SQL, and a service account outlives its creator, never administers, and
// takes its grants and tokens with it.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type ControlPlaneStore,
  type DashboardTriggerSummary,
  DEFAULT_PROJECT_ID,
  decide,
  FULL_SCOPE,
  RELEASE_TEAM_ID,
  type ReadScope,
  readScope,
} from "@swizzle/db";
import {
  createDashboardStore,
  createPostgresAccessStore,
  createPostgresApiTokenStore,
  type DatabaseClient,
} from "@swizzle/db/postgres";
import { commitDeploymentFixture, createQueuedRun } from "./verify-state-fixtures.js";

const ENVIRONMENT = "state-machine";

async function verifyAccess(client: DatabaseClient, store: ControlPlaneStore): Promise<void> {
  const access = createPostgresAccessStore({ client });
  const dashboard = createDashboardStore({ client });
  const person = async (email: string, role = "member") => {
    const { rows } = await client.pool.query<{ id: string }>(
      "INSERT INTO auth_users (name, email, role) VALUES ($1, $2, $3) RETURNING id",
      [email, email, role],
    );
    return rows[0]?.id ?? assert.fail("person row");
  };
  const mia = await person("mia@access.verify");
  const sam = await person("sam@access.verify");

  const office = await access.createProject({ name: "Office", slug: "access-office" });
  const finance = await access.createProject({ name: "Finance", slug: "access-finance" });
  assert.deepEqual((await access.projectAccess(office.id))?.protectedEnvironments, ["production"]);
  assert.deepEqual(
    (await access.listProjects())
      .filter((project) => project.id === office.id)
      .map((project) => project.protectedEnvironments),
    [["production"]],
  );
  // The release_team migration grants the Default project's production to the team Release;
  // createProject grants every new project's.
  for (const projectId of [DEFAULT_PROJECT_ID, office.id]) {
    assert.deepEqual(
      (await access.projectAccess(projectId))?.grants.flatMap((grant) =>
        grant.subject.kind === "team" && grant.subject.teamId === RELEASE_TEAM_ID
          ? [
              {
                environment: grant.on === "environment" ? grant.environment : null,
                role: grant.role,
              },
            ]
          : [],
      ),
      [{ environment: "production", role: "editor" }],
    );
  }
  await rejects(
    access.createProject({ name: "Again", slug: "access-office" }),
    "PROJECT_SLUG_CONFLICT",
  );
  await rejects(access.createProject({ name: "Bad", slug: "Not A Slug" }), "PROJECT_SLUG_INVALID");
  await rejects(
    access.createProject({ name: "Id", slug: "11111111-1111-4111-8111-111111111111" }),
    "PROJECT_SLUG_INVALID",
  );

  const report = await commitDeploymentFixture(store, "access-report", office.id);
  const exported = await commitDeploymentFixture(store, "access-export", finance.id);
  const reportTarget = { automationId: report.automationId, projectId: office.id };
  const exportTarget = { automationId: exported.automationId, projectId: finance.id };
  assert.deepEqual(await store.findAutomation("access-report"), {
    automationId: report.automationId,
    automationSlug: "access-report",
    projectId: office.id,
  });
  await assert.rejects(
    commitDeploymentFixture(store, "access-report", finance.id),
    (error: Error & { code?: string }) => error.code === "AUTOMATION_PROJECT_MISMATCH",
  );
  await rejects(store.deleteProject({ contents: null, projectId: office.id }), "PROJECT_NOT_EMPTY");
  await rejects(
    store.deleteProject({ contents: { kind: "delete" }, projectId: DEFAULT_PROJECT_ID }),
    "PROJECT_PROTECTED",
  );

  // Write outcomes come from the serialized write, including concurrent first grants.
  const outcomes = await access.createProject({
    name: "Write outcomes",
    slug: "access-write-outcomes",
  });
  const outcomeSubject = { kind: "user", userId: mia } as const;
  const viewer = { on: "project", projectId: outcomes.id, role: "viewer" } as const;
  const raced = await Promise.all([
    access.setGrant(outcomeSubject, viewer),
    access.setGrant(outcomeSubject, viewer),
    access.setGrant(outcomeSubject, viewer),
  ]);
  assert.deepEqual(raced.map((role) => role ?? "absent").sort(), ["absent", "viewer", "viewer"]);
  assert.equal(await access.setGrant(outcomeSubject, { ...viewer, role: "operator" }), "viewer");
  assert.equal(await access.setGrant(outcomeSubject, { ...viewer, role: "operator" }), "operator");
  assert.equal(await access.removeGrant(outcomeSubject, viewer), true);
  assert.equal(await access.removeGrant(outcomeSubject, viewer), false);
  const protectedOnce = { changed: true, grantsRemoved: 0 };
  assert.deepEqual(
    await access.setEnvironmentProtected(outcomes.id, "qa", true, "confirmed"),
    protectedOnce,
  );
  assert.deepEqual(await access.setEnvironmentProtected(outcomes.id, "qa", true, "confirmed"), {
    changed: false,
    grantsRemoved: 0,
  });
  await access.setGrant(outcomeSubject, {
    on: "environment",
    projectId: outcomes.id,
    environment: "qa",
    role: "editor",
  });
  await assert.rejects(
    access.setEnvironmentProtected(outcomes.id, "qa", false, "required"),
    (error: unknown) =>
      error instanceof CodedError &&
      error.code === "CONFIRMATION_REQUIRED" &&
      error.details?.grantsRemoved === 1,
  );
  assert.deepEqual(await access.setEnvironmentProtected(outcomes.id, "qa", false, "confirmed"), {
    changed: true,
    grantsRemoved: 1,
  });
  assert.deepEqual(await access.setEnvironmentProtected(outcomes.id, "qa", false, "required"), {
    changed: false,
    grantsRemoved: 0,
  });
  await store.deleteProject({ projectId: outcomes.id, contents: null });

  // Mia: viewer directly, editor through Ops, operator in production through Ops.
  const ops = await access.createTeam("Access Ops");
  assert.equal(await access.setTeamMember(ops.id, mia, true), true);
  assert.equal(await access.setTeamMember(ops.id, mia, true), false);
  const team = { kind: "team", teamId: ops.id } as const;
  await access.setGrant(team, { on: "project", projectId: office.id, role: "editor" });
  await access.setGrant(
    { kind: "user", userId: mia },
    { on: "project", projectId: office.id, role: "viewer" },
  );
  await rejects(
    access.setGrant(team, {
      environment: "staging",
      on: "environment",
      projectId: office.id,
      role: "operator",
    }),
    "ENVIRONMENT_NOT_PROTECTED",
  );
  await access.setGrant(team, {
    environment: "production",
    on: "environment",
    projectId: office.id,
    role: "operator",
  });
  await access.setGrant(
    { kind: "user", userId: sam },
    {
      automationId: exported.automationId,
      automationSlug: "access-export",
      on: "automation",
      projectId: finance.id,
      role: "viewer",
    },
  );
  // The dashboard removes an automation grant by the slug the access read names.
  assert.deepEqual((await access.projectAccess(finance.id))?.automationSlugs, {
    [exported.automationId]: "access-export",
  });

  const grants = await access.loadGrants({ instanceRole: "member", kind: "user", userId: mia });
  const edit = (environment: string) =>
    decide(grants, { action: "edit", environment }, reportTarget).allowed;
  assert.equal(edit("staging"), true, "the team's editor role counts over the direct viewer");
  assert.equal(edit("production"), false, "production caps it to the environment grant");
  assert.equal(
    decide(grants, { action: "run", environment: "production" }, reportTarget).allowed,
    true,
  );
  assert.equal(
    decide(grants, { action: "read", environment: "staging" }, exportTarget).allowed,
    false,
  );

  // The dashboard lists and counts in SQL: Mia sees office, Sam sees only the shared automation.
  const reportRun = randomUUID();
  await createQueuedRun(store, report, reportRun, `access-${randomUUID()}`, {});
  await createQueuedRun(store, exported, randomUUID(), `access-${randomUUID()}`, {});
  const scopes: Record<string, ReadScope> = {
    mia: readScope(grants, ENVIRONMENT),
    sam: readScope(
      await access.loadGrants({ instanceRole: "member", kind: "user", userId: sam }),
      ENVIRONMENT,
    ),
  };
  const seen = async (scope: ReadScope) => {
    const since = new Date(Date.now() - 60_000);
    const [automations, runs, counts, changes] = await Promise.all([
      dashboard.listAutomationSummaries(ENVIRONMENT, scope),
      dashboard.listRuns({ environment: ENVIRONMENT, scope }),
      dashboard.countRunsSince(ENVIRONMENT, since, scope),
      dashboard.listDeploymentChanges(ENVIRONMENT, since, 50, scope),
    ]);
    // Unfiltered: the automations earlier verify steps left in this environment are the negatives.
    return {
      automations: automations.map((entry) => entry.automationSlug),
      changes: [...new Set(changes.map((entry) => entry.automationSlug))],
      queued: counts.queued,
      runs: [...new Set(runs.runs.map((run) => run.automationSlug))],
    };
  };
  assert.deepEqual(await seen(scopes.mia as ReadScope), {
    automations: ["access-report"],
    changes: ["access-report"],
    queued: 1,
    runs: ["access-report"],
  });
  assert.deepEqual(await seen(scopes.sam as ReadScope), {
    automations: ["access-export"],
    changes: ["access-export"],
    queued: 1,
    runs: ["access-export"],
  });
  const none = await seen({ all: false, automations: [], projectIds: [] });
  assert.deepEqual(none, { automations: [], changes: [], queued: 0, runs: [] });

  // A summary's last run comes from its own environment, never from one the reader may not see.
  const elsewhere = await commitDeploymentFixture(
    store,
    "access-report",
    office.id,
    "access-other",
  );
  await createQueuedRun(store, elsewhere, randomUUID(), `access-${randomUUID()}`, {});
  const [summary] = await dashboard.listAutomationSummaries(ENVIRONMENT, scopes.mia as ReadScope);
  assert.equal(
    summary?.lastRun?.runId,
    reportRun,
    "the last run stays in the summary's environment",
  );

  // A child run names its automation to readers of the parent only where they may read the child.
  await createQueuedRun(
    store,
    exported,
    randomUUID(),
    `access-${randomUUID()}`,
    {},
    {
      parentRunId: reportRun,
      triggerType: "chain",
    },
  );
  const invokes = async (scope: ReadScope) => [
    (await dashboard.listAutomationSummaries(ENVIRONMENT, scope)).find(
      (entry) => entry.automationSlug === "access-report",
    )?.invokesAutomationSlugs,
    (await dashboard.getAutomationDetail("access-report", ENVIRONMENT, scope))
      ?.invokesAutomationSlugs,
  ];
  assert.deepEqual(await invokes({ all: true }), [["access-export"], ["access-export"]]);
  assert.deepEqual(
    await invokes(scopes.mia as ReadScope),
    [[], []],
    "a child in a project the reader cannot see stays unnamed",
  );

  // A chain trigger names its sources to readers of the consumer only where they may read them.
  const chainEnvironment = "access-chain";
  await commitDeploymentFixture(store, "access-chain-office", office.id, chainEnvironment);
  await commitDeploymentFixture(store, "access-chain-private", office.id, chainEnvironment);
  const chained = (sources: readonly string[]) =>
    ({
      on: "all-succeeded",
      payload: "results",
      sources: [...sources],
      type: "chain",
    }) as const;
  await commitDeploymentFixture(
    store,
    "access-after-private",
    office.id,
    chainEnvironment,
    [],
    chained(["access-chain-private"]),
  );
  await commitDeploymentFixture(
    store,
    "access-after-both",
    office.id,
    chainEnvironment,
    [],
    chained(["access-chain-office", "access-chain-private"]),
  );
  const chains = async (scope: ReadScope) => {
    const sources = (trigger: DashboardTriggerSummary | null | undefined) => ({
      hidden: trigger?.chainHiddenSourceCount,
      names: trigger?.chainSourceAutomationNames ?? [],
      slugs: trigger?.chainSourceAutomationSlugs ?? [],
    });
    const listed = await dashboard.listAutomationSummaries(chainEnvironment, scope);
    return Object.fromEntries(
      await Promise.all(
        ["access-after-private", "access-after-both"].map(async (slug) => [
          slug,
          [
            sources(listed.find((entry) => entry.automationSlug === slug)?.trigger),
            sources((await dashboard.getAutomationDetail(slug, chainEnvironment, scope))?.trigger),
          ],
        ]),
      ),
    );
  };
  const named = (names: readonly string[], hidden: number) => {
    const shown = { hidden, names, slugs: names };
    return [shown, shown];
  };
  assert.deepEqual(await chains({ all: true }), {
    "access-after-both": named(["access-chain-office", "access-chain-private"], 0),
    "access-after-private": named(["access-chain-private"], 0),
  });
  // Sharing a consumer does not share its same-project sources.
  for (const slug of ["access-chain-office", "access-after-private", "access-after-both"]) {
    const automation = await store.findAutomation(slug);
    assert.ok(automation);
    await access.setGrant(
      { kind: "user", userId: sam },
      {
        on: "automation",
        projectId: office.id,
        automationId: automation.automationId,
        automationSlug: automation.automationSlug,
        role: "viewer",
      },
    );
  }
  const shared = await access.loadGrants({ instanceRole: "member", kind: "user", userId: sam });
  assert.deepEqual(
    await chains(readScope(shared, chainEnvironment)),
    {
      "access-after-both": named(["access-chain-office"], 1),
      "access-after-private": named([], 1),
    },
    "a same-project source outside an automation-only grant is counted, not named",
  );

  await verifyHistoryAcrossMoveAndDelete({
    client,
    dashboard,
    finance: finance.id,
    office: office.id,
    reportRun,
    store,
  });

  // A revocation is in the next read; deletes take the grants they orphan with them.
  await access.setTeamMember(ops.id, mia, false);
  const afterLeaving = await access.loadGrants({
    instanceRole: "member",
    kind: "user",
    userId: mia,
  });
  assert.deepEqual(
    afterLeaving.grants.map((grant) => [grant.on, grant.role, grant.via]),
    [["project", "viewer", null]],
  );
  await access.setTeamMember(ops.id, mia, true);
  await access.setEnvironmentProtected(office.id, "production", false, "confirmed");
  assert.equal(
    (await access.loadGrants({ instanceRole: "member", kind: "user", userId: mia })).grants.some(
      (grant) => grant.on === "environment",
    ),
    false,
    "unprotecting an environment drops its grants",
  );
  await access.deleteTeam(ops.id);
  assert.deepEqual(
    (await access.loadGrants({ instanceRole: "member", kind: "user", userId: mia })).grants.map(
      (grant) => grant.via,
    ),
    [null],
    "deleting a team drops its grants",
  );
  const tokens = createPostgresApiTokenStore({ client });
  await tokens.createToken({
    holder: { kind: "person", userId: mia },
    issuedBy: { id: mia, name: "Mia" },
    name: "access",
    scope: FULL_SCOPE,
  });
  await client.pool.query("DELETE FROM auth_users WHERE id = $1", [mia]);
  const leftover = await client.pool.query(
    "SELECT (SELECT count(*) FROM grants WHERE user_id = $1) + (SELECT count(*) FROM api_tokens WHERE user_id = $1) AS n",
    [mia],
  );
  assert.equal(Number(leftover.rows[0]?.n), 0, "removing a person removes their grants and tokens");

  await verifyCredentials({
    access,
    client,
    dashboard,
    finance: finance.id,
    office: office.id,
    sam,
    store,
  });
  await verifyServiceAccounts({
    access,
    client,
    creator: await person("pia@access.verify"),
    finance: finance.id,
    office: office.id,
    rotator: await person("rob@access.verify"),
  });

  await tokens.close();
  await dashboard.close();
  await access.close();
  process.stdout.write(
    "Postgres access: team and direct grants, production cap, Release holding every project's production, SQL-scoped lists and counts, history kept in its project across a move and deleted with its automation, secrets per project, credential grants, shares and deployment bindings, service accounts and their tokens, revocation on the next read and cascading deletes passed.\n",
  );
}

/**
 * Credentials on PostgreSQL: the creator manages what they create, a deployment binds credentials
 * by id, a share binds only once accepted, and deleting a credential or revoking a share drops the
 * bindings made with it, so the next run receives nothing.
 */
async function verifyCredentials(input: {
  readonly access: ReturnType<typeof createPostgresAccessStore>;
  readonly client: DatabaseClient;
  readonly dashboard: ReturnType<typeof createDashboardStore>;
  readonly finance: string;
  readonly office: string;
  readonly sam: string;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const { client, finance, office, sam, store } = input;
  /** Each secret a finance automation declares, with the state the dashboard shows for it. */
  const shown = async (automation: string) =>
    (
      await input.dashboard.listAutomationSummaries(ENVIRONMENT, {
        all: false,
        automations: [],
        projectIds: [finance],
      })
    )
      .find((summary) => summary.automationSlug === automation)
      ?.requiredSecrets.map((secret) => [secret.name, secret.state]);
  const place = (projectId: string) => ({ environment: ENVIRONMENT, projectId });
  const declared = (projectId: string, ...secrets: string[]) =>
    store.findDeploymentCredentials({ connections: [], place: place(projectId), secrets });
  const bound = async (deploymentId: string, projectId: string) =>
    (await store.boundCredentials(deploymentId, projectId)).map((credential) => credential.name);

  await store.upsertSecret({
    ...place(office),
    creator: { kind: "user", userId: sam },
    name: "CRM_TOKEN",
    value: "v1",
  });
  const token = (await store.findCredential("secret", "CRM_TOKEN", place(office))) ?? assert.fail();
  const [held] = await store.credentialAccess([token]);
  assert.deepEqual(held?.grants, [{ right: "manage", subject: { kind: "user", userId: sam } }]);
  // Two first grants to one subject at once leave one grant, not a unique violation.
  const crew = { kind: "team", teamId: (await input.access.createTeam("Access Crew")).id } as const;
  await Promise.all(
    (["use", "use"] as const).map((right) =>
      store.setCredentialGrant(token, { right, subject: crew }),
    ),
  );
  assert.deepEqual(
    (await store.credentialAccess([token]))[0]?.grants.filter(
      (grant) => grant.subject.kind === "team",
    ),
    [{ right: "use", subject: crew }],
  );

  const crm = await commitDeploymentFixture(
    store,
    "access-crm",
    office,
    ENVIRONMENT,
    await declared(office, "CRM_TOKEN"),
  );
  assert.deepEqual(await bound(crm.deploymentId, office), ["CRM_TOKEN"]);
  assert.deepEqual(await bound(crm.deploymentId, finance), [], "a moved automation binds nothing");
  const rollbackSource = await commitDeploymentFixture(store, "access-crm", office, ENVIRONMENT);
  assert.deepEqual(await bound(rollbackSource.deploymentId, office), []);
  const rolledBack = await store.commitRollbackDeployment({
    auditEvent: { eventType: "rollback" },
    environment: ENVIRONMENT,
    targetDeploymentId: crm.deploymentId,
  });
  assert.deepEqual(
    await bound(rolledBack.deployment.deploymentId, office),
    ["CRM_TOKEN"],
    "a rollback binds what its target binds",
  );

  // A share binds once the receiving project accepts it, and its revocation unbinds.
  const offered = await store.offerCredentialShare({
    accepted: false,
    credential: token,
    offeredBy: sam,
    projectId: finance,
  });
  assert.deepEqual(await declared(finance, "CRM_TOKEN"), [], "an offer alone binds nothing");
  await store.acceptCredentialShare({
    acceptedBy: null,
    projectId: finance,
    shareId: offered.shareId,
  });
  const viaShare = await declared(finance, "CRM_TOKEN");
  assert.deepEqual(
    viaShare.map((found) => found.shareId),
    [offered.shareId],
  );
  const ledger = await commitDeploymentFixture(
    store,
    "access-ledger",
    finance,
    ENVIRONMENT,
    viaShare,
  );
  assert.deepEqual(await bound(ledger.deploymentId, finance), ["CRM_TOKEN"]);
  assert.deepEqual(await shown("access-ledger"), [["CRM_TOKEN", "bound"]]);
  assert.equal(await store.removeCredentialShare(offered.shareId), true);
  assert.deepEqual(await bound(ledger.deploymentId, finance), [], "a revoked share unbinds");
  assert.deepEqual(await shown("access-ledger"), [["CRM_TOKEN", "missing"]]);
  // Shared again, the secret waits for the next deploy to bind it.
  const reoffered = await store.offerCredentialShare({
    accepted: true,
    credential: token,
    offeredBy: sam,
    projectId: finance,
  });
  assert.deepEqual(await shown("access-ledger"), [["CRM_TOKEN", "unbound"]]);
  assert.equal(await store.removeCredentialShare(reoffered.shareId), true);

  // An authorization checked against no connection, or another one, never writes the stored one.
  const authorize = (reauthorizes: string | null) =>
    store.beginConnectionAuthorization({
      ...place(office),
      clientId: reauthorizes === null ? "first" : "second",
      clientSecret: "client-secret",
      codeVerifier: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      name: "crm-oauth",
      provider: "google",
      reauthorizes,
      redirectUri: "https://swizzle.verify/oauth/callback/google",
      scopes: [],
      stateHash: randomUUID(),
    });
  const crmOauth = await authorize(null);
  for (const stale of [null, randomUUID()]) {
    await assert.rejects(
      authorize(stale),
      (error: Error & { code?: string }) => error.code === "CREDENTIAL_CHANGED",
    );
  }
  assert.equal((await authorize(crmOauth.id)).clientId, "second");

  // A secret write or delete checked against one secret never touches its replacement.
  const checked = await store.upsertSecret({ ...place(office), name: "CRM_KEY", value: "v1" });
  assert.equal(await store.deleteSecret(checked.id), true);
  const replacement = await store.upsertSecret({ ...place(office), name: "CRM_KEY", value: "v2" });
  for (const replaces of [null, checked.id]) {
    await assert.rejects(
      store.upsertSecret({ ...place(office), name: "CRM_KEY", replaces, value: "stale" }),
      (error: Error & { code?: string }) =>
        error.code === (replaces === null ? "SECRET_ALREADY_EXISTS" : "CREDENTIAL_CHANGED"),
    );
  }
  assert.equal(await store.deleteSecret(checked.id), false);
  assert.equal(
    (await store.resolveSecrets([replacement.id]))[0]?.value,
    "v2",
    "the replacement keeps its value",
  );

  // Two projects offering the same name leave the receiver to choose.
  const legal = await input.access.createProject({ name: "Legal", slug: "access-legal" });
  for (const projectId of [office, legal.id]) {
    await store.upsertSecret({ ...place(projectId), name: "SHARED_KEY", value: projectId });
    const shared =
      (await store.findCredential("secret", "SHARED_KEY", place(projectId))) ?? assert.fail();
    await store.offerCredentialShare({
      accepted: true,
      credential: shared,
      offeredBy: null,
      projectId: finance,
    });
  }
  await assert.rejects(
    declared(finance, "SHARED_KEY"),
    (error: Error & { code?: string }) => error.code === "CREDENTIAL_AMBIGUOUS",
  );

  // A credential deleted between finding and committing refuses the deploy.
  const found = await declared(office, "CRM_TOKEN");
  assert.equal(await store.deleteSecret(token.id), true);
  await assert.rejects(
    commitDeploymentFixture(store, "access-crm", office, ENVIRONMENT, found),
    (error: Error & { code?: string }) => error.code === "DEPLOYMENT_CREDENTIALS_CHANGED",
  );
  assert.equal(
    (await store.getActiveDeploymentBySlug("access-crm", ENVIRONMENT))?.deploymentId,
    rolledBack.deployment.deploymentId,
    "the refused deploy left the active deployment",
  );
  assert.deepEqual(await bound(rolledBack.deployment.deploymentId, office), []);
  const leftover = await client.pool.query(
    "SELECT (SELECT count(*) FROM credential_grants WHERE secret_id = $1) + (SELECT count(*) FROM deployment_credentials WHERE secret_id = $1) AS n",
    [token.id],
  );
  assert.equal(Number(leftover.rows[0]?.n), 0, "deleting a secret removes its grants and bindings");
}

/**
 * Moving and deleting `access-report` (office, with the queued run `reportRun` in ENVIRONMENT and
 * one more in access-other): a move leaves runs and audit events in office, a delete takes every
 * run of the automation with it and keeps its audit events, the name frees up, and each project
 * holds its own secret of a name.
 */
async function verifyHistoryAcrossMoveAndDelete(input: {
  readonly client: DatabaseClient;
  readonly dashboard: ReturnType<typeof createDashboardStore>;
  readonly finance: string;
  readonly office: string;
  readonly reportRun: string;
  readonly store: ControlPlaneStore;
}): Promise<void> {
  const { client, dashboard, finance, office, reportRun, store } = input;
  const only = (projectId: string): ReadScope => ({
    all: false,
    automations: [],
    projectIds: [projectId],
  });
  const since = new Date(Date.now() - 60_000);
  const historyIn = async (projectId: string) => ({
    changes: (await dashboard.listDeploymentChanges(ENVIRONMENT, since, 50, only(projectId)))
      .filter((change) => change.automationSlug === "access-report")
      .map((change) => change.target.projectId),
    // The name filter, as the Runs page uses it.
    runs: (
      await dashboard.listRuns({
        automationSlug: "access-report",
        environment: ENVIRONMENT,
        scope: only(projectId),
      })
    ).runs.map((run) => run.runId),
  });
  const pauseEverywhere = async () => {
    for (const environment of [ENVIRONMENT, "access-other"]) {
      await store.updateAutomationTriggerStatus({
        automationSlug: "access-report",
        environment,
        status: "paused",
        updatedAt: new Date().toISOString(),
      });
    }
  };

  await assert.rejects(
    store.moveAutomation({ automationSlug: "access-report", projectId: finance }),
    (error: Error & { code?: string }) => error.code === "AUTOMATION_NOT_PAUSED",
    "an active trigger blocks a move",
  );
  await pauseEverywhere();
  const moved = await store.moveAutomation({ automationSlug: "access-report", projectId: finance });
  assert.equal(moved.projectId, finance);
  assert.equal((await store.findAutomation("access-report"))?.projectId, finance);
  assert.equal((await store.getRun(reportRun))?.projectId, office, "a run keeps its project");
  assert.deepEqual(await historyIn(office), { changes: [office], runs: [reportRun] });
  assert.deepEqual(await historyIn(finance), { changes: [], runs: [] });
  assert.deepEqual(
    await store.listDeploymentAuditEventsByAutomationSlug("access-report", ENVIRONMENT),
    [],
    "the automation's audit starts over in its new project",
  );

  // A run written after the move belongs to the new project.
  const [active] = await store.listDeploymentsByAutomationSlug("access-report", ENVIRONMENT);
  const laterRun = randomUUID();
  await createQueuedRun(
    store,
    active ?? assert.fail("active deployment"),
    laterRun,
    `access-${randomUUID()}`,
    {},
  );
  assert.equal((await store.getRun(laterRun))?.projectId, finance);

  await assert.rejects(
    store.deleteAutomation({ automationSlug: "access-report", environment: ENVIRONMENT }),
    (error: Error & { code?: string }) => error.code === "AUTOMATION_RUNS_ACTIVE",
    "unfinished runs block a delete",
  );
  await client.pool.query(
    "UPDATE runs SET status = 'succeeded', finished_at = now() WHERE automation_id = $1",
    [moved.automationId],
  );
  const financeBefore = await store.countProjectContents(finance);
  const deleted = await store.deleteAutomation({
    automationSlug: "access-report",
    environment: ENVIRONMENT,
  });
  assert.deepEqual(deleted.deletedCounts.runs, 3, "its runs in both projects go with it");
  assert.ok(deleted.kept.auditEvents > 0, "its audit events stay");
  assert.equal(await store.findAutomation("access-report"), null);
  assert.equal(await store.getRun(reportRun), null);
  assert.equal(await store.getRun(laterRun), null);
  assert.deepEqual((await historyIn(office)).runs, []);
  assert.deepEqual((await historyIn(finance)).runs, []);
  const reused = await commitDeploymentFixture(store, "access-report", office);
  assert.notEqual(reused.automationId, moved.automationId, "the name is free for a new automation");
  assert.deepEqual(
    await store.countProjectContents(finance),
    {
      automations: (financeBefore?.automations ?? 0) - 1,
      credentials: financeBefore?.credentials,
      runs: (financeBefore?.runs ?? 0) - 1,
    },
    "the automation and its run leave finance; its audit events do not count",
  );

  // A delete in flight holds the automation's row. A run or a resume that starts meanwhile waits
  // for it, then finds the automation gone instead of landing after the delete's checks.
  const deleting = await client.pool.connect();
  try {
    await deleting.query("BEGIN");
    await deleting.query("DELETE FROM automations WHERE id = $1", [reused.automationId]);
    const starting = createQueuedRun(store, reused, randomUUID(), `access-${randomUUID()}`, {});
    const resuming = store.updateAutomationTriggerStatus({
      automationSlug: "access-report",
      environment: reused.environment,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    starting.catch(() => {});
    await untilLockWaiters(client, 2);
    await deleting.query("COMMIT");
    await assert.rejects(
      starting,
      (error: Error & { code?: string }) => error.code === "AUTOMATION_NOT_FOUND",
      "no run starts for an automation deleted meanwhile",
    );
    assert.equal(await resuming, null, "no trigger resumes for an automation deleted meanwhile");
  } finally {
    deleting.release();
  }

  // Each project holds its own secret of a name; neither reads the other's.
  const place = (projectId: string) => ({ environment: "production", projectId });
  const officeToken = await store.upsertSecret({
    ...place(office),
    name: "ACCESS_TOKEN",
    value: "office-value",
  });
  await store.upsertSecret({ ...place(finance), name: "ACCESS_TOKEN", value: "finance-value" });
  const value = async (projectId: string) => {
    const secret = await store.findCredential("secret", "ACCESS_TOKEN", place(projectId));
    return secret === null ? undefined : (await store.resolveSecrets([secret.id]))[0]?.value;
  };
  assert.equal(await value(office), "office-value");
  assert.equal(await value(finance), "finance-value");
  assert.deepEqual(
    (await store.listSecrets("production", [office])).map((secret) => secret.projectId),
    [office],
  );
  assert.equal(await store.deleteSecret(officeToken.id), true);
  assert.equal(
    await value(finance),
    "finance-value",
    "deleting one project's secret keeps the other",
  );
}

/**
 * Service accounts on PostgreSQL: a name is unique per project, the database refuses admin to an
 * account, its token survives its creator and rotates under one name until it expires, and deleting the account
 * takes its grants and tokens with it.
 */
async function verifyServiceAccounts(input: {
  readonly access: ReturnType<typeof createPostgresAccessStore>;
  readonly client: DatabaseClient;
  readonly creator: string;
  readonly finance: string;
  readonly office: string;
  readonly rotator: string;
}): Promise<void> {
  const { access, client, finance, office } = input;
  const tokens = createPostgresApiTokenStore({ client });
  const creator = { id: input.creator, name: "Creator" };
  const rotator = { id: input.rotator, name: "Rotator" };
  const deployer = await access.createServiceAccount({
    createdBy: creator,
    name: "Deployer",
    projectId: office,
  });
  await rejects(
    access.createServiceAccount({ createdBy: creator, name: "deployer", projectId: office }),
    "SERVICE_ACCOUNT_NAME_CONFLICT",
  );
  await access.createServiceAccount({ createdBy: creator, name: "deployer", projectId: finance });
  assert.equal((await access.getServiceAccount(office, "DEPLOYER"))?.id, deployer.id);

  const subject = { kind: "service-account", serviceAccountId: deployer.id } as const;
  await assert.rejects(
    access.setGrant(subject, { on: "project", projectId: office, role: "admin" }),
    (error: Error) => /grants_admin/u.test(String(error.cause ?? error)),
    "the database refuses admin to a service account",
  );
  await access.setGrant(subject, { on: "project", projectId: office, role: "editor" });
  const grants = await access.loadGrants({
    kind: "service-account",
    serviceAccountId: deployer.id,
  });
  assert.equal(
    decide(
      grants,
      { action: "edit", environment: ENVIRONMENT },
      { automationId: null, projectId: office },
    ).allowed,
    true,
  );

  const holder = { kind: "service-account", serviceAccountId: deployer.id } as const;
  const scope = { environments: [ENVIRONMENT], projectIds: null, role: "editor" } as const;
  const first = await tokens.createToken({ holder, issuedBy: creator, name: "ci", scope });
  await assert.rejects(
    tokens.createToken({ holder, issuedBy: creator, name: "ci", scope }),
    (error: Error & { code?: string }) => error.code === "API_TOKEN_NAME_CONFLICT",
  );
  await client.pool.query("DELETE FROM auth_users WHERE id = $1", [creator.id]);
  assert.deepEqual(
    (await access.findServiceAccount(deployer.id))?.createdBy,
    creator,
    "the account keeps who created it",
  );
  const verified = await tokens.verifyToken(first.token);
  assert.deepEqual(
    [verified?.holder, verified?.issuedBy, verified?.scope],
    [holder, creator, scope],
    "the token outlives the person who minted it and keeps who that was",
  );

  const rotated = (await tokens.rotateToken(holder, "ci", rotator)) ?? assert.fail("rotated");
  assert.equal(await tokens.verifyToken(first.token), null, "rotation stops the old token");
  assert.deepEqual(
    [rotated.name, rotated.scope, rotated.issuedBy],
    ["ci", scope, rotator],
    "the new token keeps name and scope",
  );
  assert.equal(await tokens.rotateToken(holder, first.id, rotator), null);
  await tokens.revokeToken(holder, "ci");
  const again = await tokens.createToken({ holder, issuedBy: rotator, name: "ci", scope });
  const expired = await tokens.createToken({ holder, issuedBy: rotator, name: "old", scope });
  await client.pool.query("UPDATE api_tokens SET expires_at = now() WHERE id = $1", [expired.id]);
  assert.equal(
    await tokens.rotateToken(holder, "old", rotator),
    null,
    "an expired token rotates not",
  );

  assert.equal(await access.deleteServiceAccount(deployer.id), true);
  const leftover = await client.pool.query(
    "SELECT (SELECT count(*) FROM grants WHERE service_account_id = $1) + (SELECT count(*) FROM api_tokens WHERE service_account_id = $1) AS n",
    [deployer.id],
  );
  assert.equal(Number(leftover.rows[0]?.n), 0, "deleting an account removes its grants and tokens");
  assert.equal(await tokens.verifyToken(again.token), null);
  await tokens.close();
}

async function rejects(promise: Promise<unknown>, code: CodedError["code"]): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof CodedError && error.code === code);
}

it("access", async () => {
  const client = testDatabase();
  const store = testControlPlaneStore();
  await verifyAccess(client, store);
});

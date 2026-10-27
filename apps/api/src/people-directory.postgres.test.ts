import { FULL_SCOPE, RELEASE_TEAM_ID } from "@swizzle/db";
import { expect, it, onTestFinished } from "vitest";
import { testAccessStore, testApiTokenStore } from "../../../test/stores.js";
import { createAutomationFixture, deployFixture } from "../test/automations.js";
import { testPeople } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

it("keeps administrative account state out of a member's directory", async () => {
  const tokens = testApiTokenStore();
  const people = testPeople();
  const owner = await people.bearer(tokens, "owner@directory.test", "owner");
  const member = await people.bearer(tokens, "member@directory.test");
  const app = await buildTestServer({ apiTokenStore: tokens, auth: people.auth });
  onTestFinished(() => app.close());
  const list = (authorization: string) =>
    app.inject({ headers: { authorization }, method: "GET", url: "/users" });
  const full = await list(owner.authorization);
  expect(full.statusCode).toBe(200);
  expect(full.json().users).toContainEqual({
    email: "owner@directory.test",
    id: owner.userId,
    name: "owner",
    role: "owner",
    suspended: false,
    twoFactorEnabled: false,
  });
  const limited = await list(member.authorization);
  expect(limited.statusCode).toBe(403);
  expect(limited.json()).toMatchObject({ code: "ACCESS_DENIED" });
  const directory = await app.inject({
    headers: { authorization: member.authorization },
    method: "GET",
    url: "/directory",
  });
  expect(directory.statusCode).toBe(200);
  expect(directory.json()).toEqual({ users: [], teams: [] });
});

it("scopes sharing identities to visible projects for people, narrowed tokens and service accounts", async () => {
  const tokens = testApiTokenStore();
  const people = testPeople();
  const access = testAccessStore();
  const owner = await people.bearer(tokens, "owner@directory.test", "owner");
  const admin = await people.bearer(tokens, "admin@directory.test", "admin");
  const member = await people.bearer(tokens, "member@directory.test");
  const peer = await people.add("peer@directory.test");
  const hidden = await people.add("hidden@directory.test");
  const suspended = await people.add("suspended@directory.test");
  const office = await access.createProject({ name: "Office", slug: "office" });
  const finance = await access.createProject({ name: "Finance", slug: "finance" });
  const team = await access.createTeam("Office team");
  const privateTeam = await access.createTeam("Finance team");
  const app = await buildTestServer({
    accessStore: access,
    apiTokenStore: tokens,
    auth: people.auth,
  });
  onTestFinished(() => app.close());
  const send = (
    authorization: string,
    url: string,
    method: "GET" | "PUT" | "DELETE" = "GET",
    payload?: object,
  ) =>
    app.inject({
      headers: { authorization },
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
  await access.setTeamMember(team.id, peer, true);
  await access.setTeamMember(privateTeam.id, hidden, true);
  await access.setGrant(
    { kind: "team", teamId: team.id },
    { on: "project", projectId: office.id, role: "viewer" },
  );
  await access.setGrant(
    { kind: "team", teamId: privateTeam.id },
    { on: "project", projectId: finance.id, role: "viewer" },
  );
  await access.setGrant(
    { kind: "user", userId: member.userId },
    { on: "project", projectId: office.id, role: "admin" },
  );
  await access.setGrant(
    { kind: "user", userId: suspended },
    { on: "project", projectId: office.id, role: "viewer" },
  );
  expect(
    (await send(owner.authorization, `/users/${suspended}/suspension`, "PUT")).statusCode,
  ).toBe(200);
  const ci = await access.createServiceAccount({
    projectId: office.id,
    name: "ci",
    createdBy: { id: owner.userId, name: "owner" },
  });
  await access.setGrant(
    { kind: "service-account", serviceAccountId: ci.id },
    { on: "project", projectId: office.id, role: "editor" },
  );
  const serviceToken = await tokens.createToken({
    holder: { kind: "service-account", serviceAccountId: ci.id },
    name: "ci",
    issuedBy: null,
    scope: { ...FULL_SCOPE, role: "editor" },
  });
  const narrowToken = await tokens.createToken({
    holder: { kind: "person", userId: owner.userId },
    name: "viewer",
    issuedBy: null,
    scope: { role: "viewer", projectIds: [office.id], environments: ["staging"] },
  });
  const noProjects = await people.bearer(tokens, "ungranted@directory.test");
  const expectedDirectory = {
    teams: [
      { id: team.id, name: "Office team" },
      { id: RELEASE_TEAM_ID, name: "Release" },
    ],
    users: [
      { id: admin.userId, name: "admin", email: "admin@directory.test" },
      { id: member.userId, name: "member", email: "member@directory.test" },
      { id: owner.userId, name: "owner", email: "owner@directory.test" },
      { id: peer, name: "peer", email: "peer@directory.test" },
    ],
  };
  for (const authorization of [
    member.authorization,
    `Bearer ${serviceToken.token}`,
    `Bearer ${narrowToken.token}`,
    noProjects.authorization,
  ]) {
    for (const url of ["/users", "/teams"]) {
      const response = await send(authorization, url);
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toMatchObject({ code: "ACCESS_DENIED" });
      expect(response.body).not.toContain("twoFactorEnabled");
      expect(response.body).not.toContain("suspended");
    }
    const response = await send(authorization, "/directory?environment=staging");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      authorization === noProjects.authorization ? { users: [], teams: [] } : expectedDirectory,
    );
  }
  expect(
    (await send(`Bearer ${narrowToken.token}`, "/directory?environment=production")).json(),
  ).toEqual({ users: [], teams: [] });
  for (const authorization of [owner.authorization, admin.authorization]) {
    const response = await send(authorization, "/users");
    expect(response.statusCode).toBe(200);
    expect(response.json().users).toHaveLength(7);
    expect(response.json().users).toContainEqual({
      id: suspended,
      email: "suspended@directory.test",
      name: "suspended",
      role: "member",
      suspended: true,
      twoFactorEnabled: false,
    });
    const teams = await send(authorization, "/teams");
    expect(teams.statusCode).toBe(200);
    expect(teams.json().teams).toContainEqual(
      expect.objectContaining({ id: privateTeam.id, memberIds: [hidden] }),
    );
  }
  // A direct automation share also connects its recipient to the project's directory.
  const fixture = await createAutomationFixture({
    name: "report",
    mainJs: "console.log('{}');",
    path: "/report",
  });
  expect(
    (
      await deployFixture(
        app,
        fixture,
        { environment: "staging", project: office.id },
        { headers: { authorization: owner.authorization } },
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await send(owner.authorization, "/projects/office/grants", "PUT", {
        user: member.userId,
        automation: "report",
        role: "viewer",
      })
    ).statusCode,
  ).toBe(200);
  await access.removeGrant(
    { kind: "user", userId: member.userId },
    { on: "project", projectId: office.id },
  );
  expect((await send(member.authorization, "/directory?environment=staging")).json()).toEqual(
    expectedDirectory,
  );
  expect(
    (
      await send(
        owner.authorization,
        `/projects/office/grants?user=${member.userId}&automation=report`,
        "DELETE",
      )
    ).statusCode,
  ).toBe(200);
  expect((await send(member.authorization, "/directory?environment=staging")).json()).toEqual({
    users: [],
    teams: [],
  });
});

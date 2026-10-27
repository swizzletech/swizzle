import { describe, expect, it } from "vitest";

import {
  type AccessGrants,
  type CredentialGrant,
  type CredentialTarget,
  credentialRight,
  decide,
  FULL_SCOPE,
  type Grant,
  isInstanceOperator,
  mayUseCredential,
  readScope,
} from "./access.js";

const OFFICE = "project-office";
const EXPORT = { automationId: "automation-export", projectId: OFFICE };
const REPORT = { automationId: "automation-report", projectId: OFFICE };
const TEAM = { teamId: "team-office", teamName: "Office" };
const ANNA = "user-anna";
const PRODUCTION_PROTECTED = [{ environment: "production", projectId: OFFICE }];

function member(grants: readonly Grant[], protectedEnvironments = PRODUCTION_PROTECTED) {
  return {
    grants,
    instanceRole: "member",
    protectedEnvironments,
    scope: null,
    subjects: [
      { kind: "user", userId: ANNA },
      { kind: "team", teamId: TEAM.teamId },
    ],
  } satisfies AccessGrants;
}

describe("decide", () => {
  it("hides a project from a member without a grant on it", () => {
    expect(decide(member([]), { action: "read", environment: "staging" }, EXPORT)).toEqual({
      allowed: false,
      protectedEnvironment: null,
      required: "viewer",
      role: null,
      scope: null,
      sources: [],
      visible: false,
    });
  });

  it("lets owners and admins do everything without a grant", () => {
    for (const instanceRole of ["owner", "admin"] as const) {
      const access = { ...member([]), instanceRole };
      expect(decide(access, { action: "edit", environment: "production" }, EXPORT)).toEqual({
        allowed: true,
      });
    }
  });

  it("takes the highest of a team grant and a direct grant, and names both", () => {
    const viaTeam: Grant = { on: "project", projectId: OFFICE, role: "editor", via: TEAM };
    const direct: Grant = { on: "project", projectId: OFFICE, role: "viewer", via: null };
    const access = member([direct, viaTeam]);

    expect(decide(access, { action: "edit", environment: "staging" }, EXPORT)).toEqual({
      allowed: true,
    });
    expect(decide(access, { action: "administer" }, EXPORT)).toEqual({
      allowed: false,
      protectedEnvironment: null,
      required: "admin",
      role: "editor",
      scope: null,
      sources: [direct, viaTeam],
      visible: true,
    });
  });

  it("caps a project editor in a protected environment to its environment grant", () => {
    const editor: Grant = { on: "project", projectId: OFFICE, role: "editor", via: TEAM };
    const production = { environment: "production" };

    expect(decide(member([editor]), { action: "read", ...production }, EXPORT)).toMatchObject({
      allowed: false,
      role: null,
      visible: true,
    });

    const release: Grant = {
      environment: "production",
      on: "environment",
      projectId: OFFICE,
      role: "operator",
      via: null,
    };
    const capped = member([editor, release]);
    expect(decide(capped, { action: "run", ...production }, EXPORT)).toEqual({ allowed: true });
    expect(decide(capped, { action: "edit", ...production }, EXPORT)).toMatchObject({
      allowed: false,
      protectedEnvironment: "production",
      required: "editor",
      role: "operator",
      scope: null,
      visible: true,
    });
  });

  it("blames the protection only when the role without it would do", () => {
    const releaseGrant: Grant = {
      environment: "production",
      on: "environment",
      projectId: OFFICE,
      role: "editor",
      via: { teamId: "team-release", teamName: "Release" },
    };
    const edit = { action: "edit", environment: "production" } as const;
    const viewer: Grant = { on: "project", projectId: OFFICE, role: "viewer", via: null };
    const editor: Grant = { on: "project", projectId: OFFICE, role: "editor", via: null };
    const operatorToken = {
      ...member([editor, releaseGrant]),
      scope: { ...FULL_SCOPE, role: "operator" as const },
    };

    expect(decide(member([editor]), edit, EXPORT)).toMatchObject({
      protectedEnvironment: "production",
    });
    // In Release, but the project role or the token is what falls short.
    expect(decide(member([viewer, releaseGrant]), edit, EXPORT)).toMatchObject({
      protectedEnvironment: null,
    });
    expect(decide(operatorToken, edit, EXPORT)).toMatchObject({ protectedEnvironment: null });
  });

  it("gives no access through an environment grant alone", () => {
    const release: Grant = {
      environment: "production",
      on: "environment",
      projectId: OFFICE,
      role: "editor",
      via: null,
    };
    expect(
      decide(member([release]), { action: "read", environment: "production" }, EXPORT),
    ).toMatchObject({ allowed: false, visible: false });
  });

  it("keeps a project admin's access in a protected environment", () => {
    const admin: Grant = { on: "project", projectId: OFFICE, role: "admin", via: null };
    expect(decide(member([admin]), { action: "edit", environment: "production" }, EXPORT)).toEqual({
      allowed: true,
    });
  });

  it("lets a shared automation run without opening its project", () => {
    const share: Grant = { ...EXPORT, on: "automation", role: "operator", via: null };
    const access = member([share]);
    const staging = { environment: "staging" };

    expect(decide(access, { action: "run", ...staging }, EXPORT)).toEqual({ allowed: true });
    expect(decide(access, { action: "edit", ...staging }, EXPORT)).toMatchObject({
      allowed: false,
      visible: true,
    });
    expect(decide(access, { action: "read", ...staging }, REPORT)).toMatchObject({
      allowed: false,
      visible: false,
    });
    expect(
      decide(access, { action: "read", ...staging }, { automationId: null, projectId: OFFICE }),
    ).toMatchObject({ allowed: false, visible: false });
  });

  it("does not let a share skip a protected environment", () => {
    const share: Grant = { ...EXPORT, on: "automation", role: "editor", via: null };
    expect(
      decide(member([share]), { action: "read", environment: "production" }, EXPORT),
    ).toMatchObject({ allowed: false, role: null, visible: true });
  });

  it("deletes only with edit rights in every protected environment", () => {
    const editor: Grant = { on: "project", projectId: OFFICE, role: "editor", via: null };
    expect(decide(member([editor]), { action: "delete" }, EXPORT)).toMatchObject({
      allowed: false,
      role: null,
      visible: true,
    });
    const release: Grant = {
      environment: "production",
      on: "environment",
      projectId: OFFICE,
      role: "editor",
      via: null,
    };
    expect(decide(member([editor, release]), { action: "delete" }, EXPORT)).toEqual({
      allowed: true,
    });
  });
});

describe("token scope", () => {
  const FINANCE = { automationId: "automation-ledger", projectId: "project-finance" };
  const officeEditor = { environments: null, projectIds: [OFFICE], role: "editor" } as const;

  it("lets only an owner's full-scope token operate the instance", () => {
    const owner = { ...member([]), instanceRole: "owner" } as const;
    expect(isInstanceOperator({ ...owner, scope: FULL_SCOPE })).toBe(true);
    expect(isInstanceOperator({ ...owner, scope: officeEditor })).toBe(false);
  });

  it("caps an owner's narrowed token at its role and projects", () => {
    const token = { ...member([]), instanceRole: "owner", scope: officeEditor } as const;
    const staging = { environment: "staging" };
    expect(decide(token, { action: "edit", ...staging }, EXPORT)).toEqual({ allowed: true });
    expect(decide(token, { action: "administer" }, EXPORT)).toMatchObject({
      allowed: false,
      role: "editor",
    });
    expect(decide(token, { action: "read", ...staging }, FINANCE)).toMatchObject({
      allowed: false,
      visible: false,
    });
    expect(readScope(token, "staging")).toEqual({
      all: false,
      automations: [],
      projectIds: [OFFICE],
    });
  });

  it("keeps a token at its role when its person gains a higher grant", () => {
    const admin: Grant = { on: "project", projectId: OFFICE, role: "admin", via: null };
    const token = { ...member([admin]), scope: { ...officeEditor, role: "operator" } } as const;
    expect(decide(token, { action: "run", environment: "staging" }, EXPORT)).toEqual({
      allowed: true,
    });
    expect(decide(token, { action: "edit", environment: "staging" }, EXPORT)).toMatchObject({
      allowed: false,
      role: "operator",
      scope: token.scope,
    });
  });

  it("names a token's scope in a refusal only when the scope lowered the role", () => {
    const editor: Grant = { on: "project", projectId: OFFICE, role: "editor", via: null };
    const token = { ...member([editor]), scope: FULL_SCOPE };
    expect(decide(token, { action: "administer" }, EXPORT)).toMatchObject({
      allowed: false,
      role: "editor",
      scope: null,
    });
  });

  it("never administers the whole project through a token limited to some environments", () => {
    const admin: Grant = { on: "project", projectId: OFFICE, role: "admin", via: null };
    const scope = { environments: ["staging"], projectIds: null, role: "admin" } as const;
    const token = { ...member([admin]), scope };
    expect(decide(token, { action: "administer" }, EXPORT)).toMatchObject({
      allowed: false,
      role: "editor",
      visible: true,
    });
    expect(decide(token, { action: "edit", environment: "staging" }, EXPORT)).toEqual({
      allowed: true,
    });
  });

  it("holds no right on a credential outside the token's projects, even with a grant on it", () => {
    const ledgerKey: CredentialTarget = {
      environment: "staging",
      id: "secret-ledger",
      kind: "secret",
      projectId: FINANCE.projectId,
    };
    const useGrant: CredentialGrant = { right: "use", subject: { kind: "user", userId: ANNA } };
    const access = member([]);
    expect(credentialRight(access, ledgerKey, [useGrant])).toBe("use");
    expect(credentialRight({ ...access, scope: officeEditor }, ledgerKey, [useGrant])).toBeNull();
  });

  it("reaches nothing outside the token's environments", () => {
    const editor: Grant = { on: "project", projectId: OFFICE, role: "editor", via: null };
    const scope = { environments: ["staging"], projectIds: null, role: "admin" } as const;
    const token = { ...member([editor], []), scope };
    expect(decide(token, { action: "edit", environment: "staging" }, EXPORT)).toEqual({
      allowed: true,
    });
    expect(decide(token, { action: "read", environment: "production" }, EXPORT)).toMatchObject({
      allowed: false,
      role: null,
    });
    expect(readScope(token, "production")).toEqual({
      all: false,
      automations: [],
      projectIds: [],
    });
  });
});

describe("readScope", () => {
  it("lists a granted project, a shared automation, and nothing capped away", () => {
    const share: Grant = { ...REPORT, on: "automation", role: "viewer", via: null };
    const other: Grant = { on: "project", projectId: "project-finance", role: "viewer", via: null };
    const access = member([share, other]);

    expect(readScope(access, "staging")).toEqual({
      all: false,
      automations: [{ automationId: REPORT.automationId, projectId: REPORT.projectId }],
      projectIds: ["project-finance"],
    });
    expect(readScope(access, "production")).toEqual({
      all: false,
      automations: [],
      projectIds: ["project-finance"],
    });
    expect(readScope({ ...access, instanceRole: "admin" }, "production")).toEqual({ all: true });
  });
});

describe("credentialRight", () => {
  const SMTP: CredentialTarget = {
    environment: "production",
    id: "secret-smtp",
    kind: "secret",
    projectId: OFFICE,
  };
  const editor: Grant = { on: "project", projectId: OFFICE, role: "editor", via: null };
  const productionEditor: Grant = {
    environment: "production",
    on: "environment",
    projectId: OFFICE,
    role: "editor",
    via: null,
  };
  const anna = (right: CredentialGrant["right"]): CredentialGrant => ({
    right,
    subject: { kind: "user", userId: ANNA },
  });

  it("gives a project editor no right on a credential nobody granted them", () => {
    expect(credentialRight(member([editor, productionEditor]), SMTP, [])).toBeNull();
    expect(
      credentialRight(member([editor, productionEditor]), SMTP, [
        { right: "manage", subject: { kind: "user", userId: "user-bert" } },
      ]),
    ).toBeNull();
  });

  it("reaches a person through a grant to their team", () => {
    const toTeam: CredentialGrant = {
      right: "use",
      subject: { kind: "team", teamId: TEAM.teamId },
    };
    expect(credentialRight(member([]), SMTP, [toTeam])).toBe("use");
  });

  it("lets a manage grant manage only while its holder may edit the environment", () => {
    expect(credentialRight(member([editor, productionEditor]), SMTP, [anna("manage")])).toBe(
      "manage",
    );
    // Without the production grant the editor reaches no production: the grant still lets them use it.
    expect(credentialRight(member([editor]), SMTP, [anna("manage")])).toBe("use");
  });

  it("lets a project admin and an instance admin manage without a grant", () => {
    const admin: Grant = { on: "project", projectId: OFFICE, role: "admin", via: null };
    expect(credentialRight(member([admin]), SMTP, [])).toBe("manage");
    expect(credentialRight({ ...member([]), instanceRole: "admin" }, SMTP, [])).toBe("manage");
  });
});

describe("mayUseCredential", () => {
  const FINANCE = "project-finance";
  const SHARED: CredentialTarget = {
    environment: "staging",
    id: "secret-smtp",
    kind: "secret",
    projectId: OFFICE,
  };

  it("lets the admin of the project a credential is shared into bind it, not its editors", () => {
    const admin: Grant = { on: "project", projectId: FINANCE, role: "admin", via: null };
    const editor: Grant = { on: "project", projectId: FINANCE, role: "editor", via: null };
    expect(mayUseCredential(member([admin]), SHARED, [], FINANCE)).toBe(true);
    expect(mayUseCredential(member([editor]), SHARED, [], FINANCE)).toBe(false);
    expect(
      mayUseCredential(
        member([editor]),
        SHARED,
        [{ right: "use", subject: { kind: "user", userId: ANNA } }],
        FINANCE,
      ),
    ).toBe(true);
  });
});

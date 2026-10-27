import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../../test/postgres.js";
import { testApiTokenStore } from "../../../test/stores.js";
import { DEFAULT_PROJECT_ID, FULL_SCOPE } from "./access.js";
import type { CreateApiTokenInput } from "./api-tokens.js";

const OWNER = { id: "00000000-0000-4000-8000-000000000011", name: "Owner" } as const;
const ME = { kind: "person", userId: OWNER.id } as const;
const CI = {
  kind: "service-account",
  serviceAccountId: "4dadeb01-7f18-59db-a4d3-b67b6cf56d96",
} as const;

beforeEach(async () => {
  const client = testDatabase();
  await client.pool.query(
    "INSERT INTO auth_users (id, name, email, role) VALUES ($1, 'Owner', 'owner@example.test', 'owner')",
    [OWNER.id],
  );
  await client.pool.query(
    "INSERT INTO service_accounts (id, project_id, name, normalized_name, created_by, created_by_name) VALUES ($1, $2, 'CI', 'ci', $3, 'Owner')",
    [CI.serviceAccountId, DEFAULT_PROJECT_ID, OWNER.id],
  );
  await client.pool.query(
    "INSERT INTO workers (id, name, profiles, services, enrollment_expires_at) VALUES ($1, 'Machine', ARRAY['host-default'], ARRAY[]::text[], now())",
    ["9c38dcb0-0148-5917-bc1e-745c52029544"],
  );
});

function mine(name: string, scope = FULL_SCOPE): CreateApiTokenInput {
  return { holder: ME, issuedBy: OWNER, name, scope };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("api tokens", () => {
  it.each([false, true])(
    "refuses a candidate already owned by another holder, revoked=%s, without losing the current credential",
    async (revoked) => {
      const store = testApiTokenStore();
      const candidate = `swz_${"a".repeat(43)}`;
      const reserved = await store.createToken({ ...mine("reserved"), plaintext: candidate });
      if (revoked) await store.revokeToken(ME, reserved.id);
      const holder = { kind: "worker", workerId: "9c38dcb0-0148-5917-bc1e-745c52029544" } as const;
      const input = { holder, issuedBy: null, name: "worker", scope: FULL_SCOPE };

      await expect(store.createToken({ ...input, plaintext: candidate })).rejects.toMatchObject({
        code: "API_TOKEN_NAME_CONFLICT",
      });
      const current = await store.createToken(input);
      await expect(store.rotateToken(holder, current.id, null, candidate)).rejects.toMatchObject({
        code: "API_TOKEN_NAME_CONFLICT",
      });
      expect(await store.verifyToken(current.token)).toMatchObject({ id: current.id, holder });
      const replacement = await store.rotateToken(
        holder,
        current.id,
        null,
        `swz_${"b".repeat(43)}`,
      );
      expect(await store.verifyToken(replacement?.token ?? "")).toMatchObject({ holder });
      expect(await store.verifyToken(current.token)).toBeNull();
    },
  );

  it("issues tokens with the swz_ prefix and keeps ten characters for display", async () => {
    const store = testApiTokenStore();

    const created = await store.createToken(mine("ci"));

    expect(created.token).toMatch(/^swz_[A-Za-z0-9_-]{43}$/u);
    expect(created.tokenPrefix).toBe(created.token.slice(0, 10));
  });

  it("writes last_used_at once per touch interval", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z"), toFake: ["Date"] });
    const store = testApiTokenStore();
    const { token } = await store.createToken(mine("ci"));

    const first = await store.verifyToken(token);
    vi.advanceTimersByTime(30_000);
    const second = await store.verifyToken(token);
    vi.advanceTimersByTime(31_000);
    const third = await store.verifyToken(token);

    expect(first?.lastUsedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(second?.lastUsedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(third?.lastUsedAt).toBe("2030-01-01T00:01:01.000Z");
  });

  it("writes again when exactly one interval has passed", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z"), toFake: ["Date"] });
    const store = testApiTokenStore();
    const { token } = await store.createToken(mine("ci"));
    await store.verifyToken(token);

    vi.advanceTimersByTime(60_000);
    const used = await store.verifyToken(token);

    expect(used?.lastUsedAt).toBe("2030-01-01T00:01:00.000Z");
  });

  it("lists and revokes only the holder's own tokens", async () => {
    const store = testApiTokenStore();
    const own = await store.createToken(mine("ci"));
    const theirs = await store.createToken({
      holder: CI,
      issuedBy: OWNER,
      name: "ci",
      scope: { environments: null, projectIds: null, role: "editor" },
    });

    expect((await store.listTokens(ME)).map((token) => token.id)).toEqual([own.id]);
    expect(await store.revokeToken(ME, theirs.id)).toBeNull();
    expect(await store.revokeToken(ME, "ci")).toMatchObject({ id: own.id });
    expect(await store.verifyToken(theirs.token)).toMatchObject({
      holder: { kind: "service-account", serviceAccountId: CI.serviceAccountId },
    });
  });

  it("rotates a token into one with its name and scope, and the old one stops", async () => {
    const store = testApiTokenStore();
    const scope = { environments: ["staging"], projectIds: null, role: "operator" } as const;
    const old = await store.createToken({ holder: CI, issuedBy: OWNER, name: "nightly", scope });

    const admin = { id: "00000000-0000-4000-8000-000000000014", name: "Admin" };
    const rotated = await store.rotateToken(CI, "nightly", admin);

    expect(rotated).toMatchObject({ issuedBy: admin, name: "nightly", scope });
    expect(await store.verifyToken(old.token)).toBeNull();
    expect(await store.isLive(old.id)).toBe(false);
    expect(await store.verifyToken(rotated?.token ?? "")).not.toBeNull();
    expect(await store.rotateToken(CI, old.id, OWNER)).toBeNull();
  });

  it("rotates no token once it has expired", async () => {
    vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00Z"), toFake: ["Date"] });
    const store = testApiTokenStore();
    const scope = { environments: null, projectIds: null, role: "editor" } as const;
    await store.createToken({
      expiresAt: "2030-01-01T01:00:00Z",
      holder: CI,
      issuedBy: OWNER,
      name: "short",
      scope,
    });

    vi.setSystemTime(new Date("2030-01-01T01:00:00Z"));

    expect(await store.rotateToken(CI, "short", OWNER)).toBeNull();
  });

  it("acts on the token an id names, not on another token named like that id", async () => {
    const store = testApiTokenStore();
    const target = await store.createToken(mine("laptop"));
    const decoy = await store.createToken(mine(target.id));

    expect(await store.revokeToken(ME, target.id)).toMatchObject({ id: target.id });
    expect(await store.verifyToken(target.token)).toBeNull();
    expect(await store.verifyToken(decoy.token)).not.toBeNull();
  });

  it("keeps a service account token below admin and inside its account's project", async () => {
    const store = testApiTokenStore();
    const mint = (scope: CreateApiTokenInput["scope"]) =>
      store.createToken({ holder: CI, issuedBy: OWNER, name: "ci", scope });

    await expect(mint(FULL_SCOPE)).rejects.toMatchObject({ code: "API_TOKEN_SCOPE_INVALID" });
    await expect(
      mint({ environments: null, projectIds: ["project-other"], role: "editor" }),
    ).rejects.toMatchObject({ code: "API_TOKEN_SCOPE_INVALID" });
    await expect(
      store.createToken(mine("empty", { environments: [], projectIds: null, role: "viewer" })),
    ).rejects.toMatchObject({ code: "API_TOKEN_SCOPE_INVALID" });
  });
});

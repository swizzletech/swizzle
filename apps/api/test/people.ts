import { randomUUID } from "node:crypto";
import { FULL_SCOPE, type InstanceRole } from "@swizzle/db";
import { type ApiTokenStore, authUsers, hashPassword } from "@swizzle/db/postgres";

import { testDatabase } from "../../../test/postgres.js";
import { testApiTokenStore, testAuth } from "../../../test/stores.js";

import { dashboardOrigin, getAllowedOrigins } from "../src/http-shared.js";

export function testPeople(database = testDatabase()) {
  const origin = dashboardOrigin();
  const auth = testAuth(
    {
      links: origin === null ? null : { origin, mailer: null },
      trustedOrigins: getAllowedOrigins(),
    },
    database,
  );
  const add = async (
    email: string,
    options: { readonly password?: string; readonly role?: InstanceRole } = {},
  ): Promise<string> => {
    const id = randomUUID();
    const now = new Date();
    await database.db.insert(authUsers).values({
      createdAt: now,
      email,
      emailVerified: false,
      id,
      image: null,
      name: email.split("@")[0] ?? email,
      role: options.role ?? "member",
      twoFactorEnabled: false,
      updatedAt: now,
    });
    if (options.password !== undefined) {
      await database.pool.query(
        "INSERT INTO auth_accounts (id, account_id, user_id, provider_id, password, created_at, updated_at) VALUES ($1, $2::text, $2::uuid, 'credential', $3, $4, $4)",
        [randomUUID(), id, await hashPassword(options.password), now],
      );
    }
    return id;
  };
  return {
    add,
    auth,
    async setRole(userId: string, role: InstanceRole): Promise<void> {
      await database.pool.query("UPDATE auth_users SET role = $2 WHERE id = $1", [userId, role]);
    },
    async bearer(
      apiTokenStore: ApiTokenStore,
      email: string,
      role: InstanceRole = "member",
    ): Promise<{ readonly authorization: string; readonly userId: string }> {
      const userId = await add(email, { role });
      const { token } = await apiTokenStore.createToken({
        holder: { kind: "person", userId },
        issuedBy: { id: userId, name: email },
        name: "test",
        scope: FULL_SCOPE,
      });
      return { authorization: `Bearer ${token}`, userId };
    },
  };
}

export const OWNER_TOKEN = `swz_${"o".repeat(43)}`;

export async function ownerToken(database = testDatabase()): Promise<string> {
  const userId = await testPeople(database).add("owner@swizzle.test", { role: "owner" });
  const { token } = await testApiTokenStore(database).createToken({
    holder: { kind: "person", userId },
    issuedBy: { id: userId, name: "owner" },
    name: "test",
    plaintext: OWNER_TOKEN,
    scope: FULL_SCOPE,
  });
  return token;
}

export async function ownerHeaders(): Promise<{ readonly authorization: string }> {
  return { authorization: `Bearer ${await ownerToken()}` };
}

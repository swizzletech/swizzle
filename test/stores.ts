import {
  type CreateEnvironmentInput,
  createAutomationFolderStore,
  createPostgresAccessStore,
  createPostgresApiTokenStore,
  createPostgresAuditStore,
  createPostgresControlPlaneStore,
  createPostgresEnvironmentStore,
  createPostgresHostAuth,
  createPostgresSwizzleAuth,
  type DatabaseClient,
  type SwizzleAuthOptions,
} from "@swizzle/db/postgres";
import { testDatabase } from "./postgres.js";

export const testAccessStore = (client = testDatabase()) => createPostgresAccessStore({ client });
export const testApiTokenStore = (client = testDatabase()) =>
  createPostgresApiTokenStore({ client });
export const testAuditStore = (client = testDatabase()) => createPostgresAuditStore({ client });
export const testControlPlaneStore = () =>
  createPostgresControlPlaneStore({ client: testDatabase() });
export async function testFolderStore(client = testDatabase()) {
  return createAutomationFolderStore({ client });
}
export async function testEnvironmentStore(
  initial: readonly CreateEnvironmentInput[] = [],
  client = testDatabase(),
) {
  const store = createPostgresEnvironmentStore({ client });
  for (const input of initial) await store.createEnvironment(input);
  return store;
}
export function testAuth(
  options: Partial<SwizzleAuthOptions> = {},
  client: DatabaseClient = testDatabase(),
) {
  return createPostgresSwizzleAuth({
    links: null,
    effects: { grantProject: async () => {}, revokeTokens: async () => {} },
    secureCookies: false,
    setupToken: null,
    trustedOrigins: [],
    ...options,
    client,
  });
}
export const testHostAuth = () =>
  createPostgresHostAuth({ client: testDatabase(), dashboardOrigin: "http://dashboard.test" });

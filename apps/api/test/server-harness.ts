import { type AccountLinks, accountEffects } from "@swizzle/db/postgres";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import {
  testAccessStore,
  testApiTokenStore,
  testAuditStore,
  testAuth,
  testEnvironmentStore,
  testFolderStore,
} from "../../../test/stores.js";

import type { DashboardDataProvider } from "../src/dashboard.js";
import { dashboardOrigin, getAllowedOrigins } from "../src/http-shared.js";
import { type BuildServerOptions, buildServer } from "../src/server.js";

/**
 * API routes use the calling test's PostgreSQL stores. Dashboard reads require an explicit stub.
 * Every route but the public ones needs a session or a token; `ownerHeaders()` (people.ts) gives a
 * test that is not about access an owner's token.
 */
export async function buildTestServer(
  options: Partial<BuildServerOptions> & {
    readonly links?: AccountLinks;
    readonly database?: import("@swizzle/db/postgres").DatabaseClient;
    readonly platform?: BuildServerOptions["platform"] & {
      readonly auditStore?: import("@swizzle/db").AuditStore;
    };
  } = {},
) {
  const { links, database = testDatabase(), ...rest } = options;
  const accessStore = rest.accessStore ?? testAccessStore(database);
  const apiTokenStore = rest.apiTokenStore ?? testApiTokenStore(database);
  const origin = dashboardOrigin();
  const auth =
    rest.auth ??
    testAuth(
      {
        links: links ?? (origin === null ? null : { origin, mailer: null }),
        effects: accountEffects({ accessStore, apiTokenStore }),
        trustedOrigins: getAllowedOrigins(),
      },
      database,
    );
  const auditStore = rest.auditStore ?? rest.platform?.auditStore ?? testAuditStore(database);
  return buildServer({
    accessStore,
    apiTokenStore,
    auditStore,
    auth,
    automationFolderStore: await testFolderStore(database),
    dashboard: unstubbedDashboard,
    environment: "local",
    environmentStore: await testEnvironmentStore([], database),
    platform: rest.platform ?? (await testPlatform({ auditStore, client: database })),
    ...rest,
  });
}

const unstubbedDashboard = new Proxy({} as DashboardDataProvider, {
  get: (_target, method) =>
    method === "close"
      ? async () => undefined
      : async () => {
          throw new Error(`This test reads dashboard.${String(method)} without passing a stub.`);
        },
});

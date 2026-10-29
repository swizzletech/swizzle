import { lookup } from "node:dns/promises";
import {
  bootService,
  ConfigurationError,
  configureOutboundHttpProxy,
  createLogger,
  createSmtpMailer,
  readMailSettings,
  readWorkerConcurrency,
  shutdownTracing,
} from "@swizzle/core";
import { assertSecretEncryptionKeyIsConfigured } from "@swizzle/db";
import {
  type AccountLinks,
  accountEffects,
  createAutomationFolderStore,
  createDashboardStore,
  createPostgresAccessStore,
  createPostgresApiTokenStore,
  createPostgresAuditStore,
  createPostgresDispatchStore,
  createPostgresEnvironmentStore,
  createPostgresSwizzleAuth,
  createPostgresWorkerRegistry,
  provisionLocalWorker,
  readConfiguredEnvironment,
} from "@swizzle/db/postgres";
import { createPlatformServices, createServerDispatch } from "@swizzle/runtime/platform";
import { resolveSecureCookies } from "./auth-routes.js";
import { createDashboardDataProvider } from "./dashboard.js";
import { dashboardOrigin, getAllowedOrigins } from "./http-shared.js";
import { buildLocalWorkerServer } from "./local-worker-server.js";
import { assertPublicSecurityConfiguration } from "./security-config.js";
import { buildServer } from "./server.js";

const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? "0.0.0.0";

const bootLogger = createLogger("swizzle-api");
const environment = await bootService(bootLogger, async () => {
  await configureOutboundHttpProxy();
  const environment = readConfiguredEnvironment();
  assertSecretEncryptionKeyIsConfigured();
  assertPublicSecurityConfiguration();
  const origin = dashboardOrigin();
  return { links: readAccountLinks(origin), name: environment };
});

async function main() {
  const shutdownTimeoutMs = Number(process.env.SWIZZLE_SHUTDOWN_TIMEOUT_MS ?? 30_000);
  let shuttingDown = false;
  let app: ReturnType<typeof buildServer> | undefined;
  let localApp: ReturnType<typeof buildLocalWorkerServer> | undefined;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    if (app === undefined) {
      process.exit(0);
    }
    shuttingDown = true;
    app.log.info({ signal, shutdownTimeoutMs }, "Shutting down API server.");

    const timer = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), shutdownTimeoutMs).unref(),
    );
    const result = await Promise.race([
      Promise.all([localApp?.close(), app.close()]).then(async () => {
        await shutdownTracing();
        return "closed" as const;
      }),
      timer,
    ]);
    if (result === "timeout") {
      app.log.error({ shutdownTimeoutMs }, "API drain timed out — forcing exit.");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const localToken = process.env.SWIZZLE_LOCAL_WORKER_TOKEN;
    const localHost = process.env.SWIZZLE_LOCAL_WORKER_API_HOST;
    if (localToken !== undefined && localToken !== "" && !localHost)
      throw new Error(
        "A configured local identity requires SWIZZLE_LOCAL_WORKER_API_HOST on the private Compose network.",
      );
    const localWorkerId =
      localToken === undefined || localToken === ""
        ? null
        : await provisionLocalWorker({
            token: localToken,
            capacity: readWorkerConcurrency(process.env.WORKER_CONCURRENCY),
          });
    const dashboardStore = createDashboardStore();
    const platform = await createPlatformServices({ dashboardStore });
    const accessStore = createPostgresAccessStore();
    const apiTokenStore = createPostgresApiTokenStore();
    const workerRegistry = createPostgresWorkerRegistry();
    const dispatch = await createServerDispatch({
      registry: workerRegistry,
      dispatch: createPostgresDispatchStore({
        leaseMs: Number(process.env.SWIZZLE_WORKER_LEASE_MS ?? 90_000),
      }),
      logger: bootLogger,
    });
    app = buildServer({
      workerRegistry,
      dispatch,
      accessStore,
      apiTokenStore,
      auditStore: createPostgresAuditStore(),
      auth: createPostgresSwizzleAuth({
        links: environment.links,
        effects: accountEffects({ accessStore, apiTokenStore }),
        secureCookies: resolveSecureCookies(),
        setupToken: process.env.SWIZZLE_SETUP_TOKEN?.trim() || null,
        trustedOrigins: getAllowedOrigins(),
      }),
      automationFolderStore: createAutomationFolderStore(),
      dashboard: createDashboardDataProvider({ dashboardStore, platform, workerRegistry }),
      environment: environment.name,
      environmentStore: createPostgresEnvironmentStore(),
      platform,
    });
    app.addHook("onClose", async () => await dashboardStore.close());
    await app.listen({ host, port });
    if (localWorkerId !== null && localHost) {
      const address = await lookup(localHost);
      localApp = buildLocalWorkerServer(
        dispatch,
        workerRegistry,
        localWorkerId,
        apiTokenStore,
        platform.runnerImageChecks,
      );
      await localApp.listen({
        host: address.address,
        port: Number(process.env.SWIZZLE_LOCAL_WORKER_API_PORT ?? 19821),
      });
    }
  } catch (error) {
    if (app !== undefined) {
      app.log.error(error);
    } else {
      bootLogger.fatal(error, "Failed to configure API server.");
    }
    process.exit(1);
  }
}

/**
 * Invitations and password resets by mail, when SWIZZLE_SMTP_URL is set. Their links open the
 * dashboard at SWIZZLE_DASHBOARD_ORIGIN, so mail without it fails the boot.
 */
function readAccountLinks(origin: string | null): AccountLinks | null {
  const settings = readMailSettings(process.env);
  if (origin === null && settings !== null) {
    throw new ConfigurationError(
      "MAIL_SETTINGS_INVALID",
      "SWIZZLE_SMTP_URL needs SWIZZLE_DASHBOARD_ORIGIN, the http or https address of the dashboard its mailed links open.",
    );
  }
  return origin === null
    ? null
    : { origin, mailer: settings === null ? null : createSmtpMailer(settings) };
}

void main();

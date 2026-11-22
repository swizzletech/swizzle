import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  API_ERROR_STATUS,
  APP_NAME,
  APP_VERSION,
  type ApiErrorCode,
  type ApiErrorResponse,
  createLogger,
  isApiErrorCode,
  trace,
} from "@swizzle/core";
import {
  type AccessStore,
  type AuditStore,
  CodedError,
  ExecutionLeaseError,
  type WorkerRegistry,
} from "@swizzle/db";
import type {
  ApiTokenStore,
  AutomationFolderStore,
  EnvironmentStore,
  SwizzleAuth,
} from "@swizzle/db/postgres";
import {
  AutomationRuntimeError,
  MAX_WAIT_LINK_TOKEN_LENGTH,
  redactWaitLinks,
} from "@swizzle/runtime";
import type {
  HealthResponse,
  MetricsResponse,
  OperationsSummaryResponse,
  ReadyResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices, ServerDispatch } from "@swizzle/runtime/platform";
import Fastify, { type FastifyBodyParser } from "fastify";
import { registerAccessRoutes } from "./access-routes.js";
import {
  createApprovalRateLimiterFromEnvironment,
  registerApprovalRoutes,
} from "./approval-routes.js";
import { registerAuthGuard, registerAuthRoutes } from "./auth-routes.js";
import { registerAutomationFolderRoutes } from "./automation-folder-routes.js";
import { registerAutomationRoutes } from "./automation-routes.js";
import {
  type ClientRateLimiter,
  createClientRateLimiterFromEnvironment,
} from "./client-rate-limiter.js";
import { registerConnectionRoutes } from "./connection-routes.js";
import { registerCredentialRoutes } from "./credential-routes.js";
import type { DashboardDataProvider } from "./dashboard.js";
import { registerDashboardRoutes } from "./dashboard-routes.js";
import { MAX_BUNDLE_BYTES, registerDeploymentRoutes } from "./deployment-routes.js";
import { registerDispatchRoutes } from "./dispatch-routes.js";
import { registerEnvironmentRoutes } from "./environment-routes.js";
import {
  createEventCallbackRateLimiterFromEnvironment,
  registerEventCallbackRoutes,
} from "./event-callback-routes.js";
import {
  type ApiServer,
  getAllowedOrigins,
  getEnvironment,
  randomRequestId,
  resolveTrustProxy,
} from "./http-shared.js";
import { createMetricsRegistry } from "./metrics.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { registerPeopleRoutes } from "./people-routes.js";
import { registerAccess, routeAccess } from "./request-access.js";
import { registerAudit } from "./request-audit.js";
import { registerRequestValidation } from "./request-validation.js";
import { registerRunRoutes } from "./run-routes.js";
import { registerSecretRoutes } from "./secret-routes.js";
import { registerSecurityAuditRoute } from "./security-audit.js";
import { registerTimeoutGrantRoutes } from "./timeout-grant-routes.js";
import { registerTokenRoutes } from "./token-routes.js";
import {
  createWebhookIngressLimiterFromEnvironment,
  registerWebhookIngressRoute,
} from "./webhook-ingress.js";
import { registerWorkerRoutes } from "./worker-routes.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

const JSON_NUL_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\u0000/u;

const SECURITY_HEADERS = [
  ["Cache-Control", "no-store"],
  [
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'",
  ],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Permissions-Policy", "camera=(), geolocation=(), microphone=()"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
] as const;

export interface BuildServerOptions {
  readonly workerRegistry?: WorkerRegistry;
  readonly dispatch?: ServerDispatch;
  readonly environment: string;
  readonly platform: PlatformServices;
  readonly dashboard: DashboardDataProvider;
  readonly auth: SwizzleAuth;
  readonly accessStore: AccessStore;
  readonly environmentStore: EnvironmentStore;
  readonly automationFolderStore: AutomationFolderStore;
  readonly apiTokenStore: ApiTokenStore;
  readonly auditStore: AuditStore;
  readonly artifactsDirectory?: string;
  readonly approvalRateLimiter?: ClientRateLimiter;
  readonly authStatusRateLimiter?: ClientRateLimiter;
  readonly deploymentUploadRateLimiter?: ClientRateLimiter;
  readonly eventCallbackRateLimiter?: ClientRateLimiter;
  readonly webhookIngressLimiter?: ClientRateLimiter;
}

export function buildServer(options: BuildServerOptions) {
  const {
    accessStore,
    apiTokenStore,
    auditStore,
    auth,
    automationFolderStore,
    dashboard,
    environmentStore,
    platform,
  } = options;
  const webhookIngressLimiter =
    options.webhookIngressLimiter ?? createWebhookIngressLimiterFromEnvironment();
  const approvalRateLimiter =
    options.approvalRateLimiter ?? createApprovalRateLimiterFromEnvironment();
  const authStatusRateLimiter =
    options.authStatusRateLimiter ??
    createClientRateLimiterFromEnvironment("SWIZZLE_AUTH_STATUS_RATE_LIMIT", "120/min");
  const deploymentUploadRateLimiter =
    options.deploymentUploadRateLimiter ??
    createClientRateLimiterFromEnvironment("SWIZZLE_DEPLOYMENT_UPLOAD_RATE_LIMIT", "30/min");
  const eventCallbackRateLimiter =
    options.eventCallbackRateLimiter ?? createEventCallbackRateLimiterFromEnvironment();
  const app: ApiServer = Fastify({
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomRequestId(),
    loggerInstance: createLogger("swizzle-api"),
    requestIdHeader: "x-request-id",
    routerOptions: { maxParamLength: MAX_WAIT_LINK_TOKEN_LENGTH },
    trustProxy: resolveTrustProxy(),
  });
  app.decorate("configuredEnvironment", options.environment);
  app.addHook("onRequest", async (request) => {
    const route = request.routeOptions.url;
    if (route !== undefined) trace.getActiveSpan()?.setAttribute("http.route", route);
  });

  registerRequestValidation(app);

  app.addHook("onRequest", async (_request, reply) => {
    for (const [name, value] of SECURITY_HEADERS) reply.raw.setHeader(name, value);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const contentType = String(reply.getHeader("content-type") ?? "");
    return routeAccess(request) !== "worker" &&
      /^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(contentType) &&
      typeof payload === "string"
      ? redactWaitLinks(payload)
      : payload;
  });

  const parseJson = app.getDefaultJsonParser("error", "error");
  const parseJsonBody: FastifyBodyParser<Buffer> = (request, rawBody, done) => {
    request.rawBody = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
    const body = rawBody.toString("utf8");
    if (JSON_NUL_ESCAPE.test(body)) {
      done(
        new CodedError(
          "REQUEST_BODY_INVALID",
          "A JSON body cannot contain the NUL character (\\u0000).",
        ),
        undefined,
      );
      return;
    }
    parseJson(request, body, done);
  };
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, parseJsonBody);
  app.addContentTypeParser(
    /^application\/.+\+json(?:\s*;.*)?$/i,
    { parseAs: "buffer" },
    parseJsonBody,
  );

  void app.register(cors, {
    credentials: true,
    exposedHeaders: ["Retry-After"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    origin: (origin, callback) => {
      if (origin === undefined) {
        callback(null, true);
        return;
      }

      callback(null, getAllowedOrigins().includes(origin));
    },
  });

  void app.register(multipart, {
    limits: {
      fieldSize: 1 * 1024 * 1024,
      fields: 16,
      fileSize: MAX_BUNDLE_BYTES,
      files: 1,
    },
  });

  app.addHook("preClose", async () => {
    options.dispatch?.stop();
  });
  app.addHook("onClose", async () => {
    await Promise.all([
      options.dispatch?.close(),
      options.workerRegistry?.close(),
      accessStore.close(),
      auth.close(),
      automationFolderStore.close(),
      dashboard.close(),
      environmentStore.close(),
      platform.close(),
      apiTokenStore.close(),
      auditStore.close(),
    ]);
  });

  registerAuthGuard(app, {
    apiTokenStore,
    auth,
    accessStore,
    workerRegistry: options.workerRegistry,
  });
  registerAccess(app, {
    accessStore,
    auth,
    folders: automationFolderStore,
    platform,
    tokens: apiTokenStore,
  });
  registerAudit(app, { store: auditStore });
  registerErrorHandler(app);
  registerAuthRoutes(app, auth, authStatusRateLimiter);
  registerSecurityAuditRoute(app, auth);

  app.get<{ Reply: HealthResponse }>("/health", async () => ({
    service: "api",
    status: "ok",
    version: APP_VERSION,
  }));

  app.get<{ Reply: ReadyResponse }>("/ready", async (_request, reply) => {
    const report = await platform.checkReadiness();
    if (!report.ok) {
      reply.status(503);
    }
    const failedChecks = Object.entries(report.checks).filter(([, check]) => !check.ok);
    const artifactStorageFailure = report.checks.artifactStorage.ok
      ? null
      : report.checks.artifactStorage;
    const notReadyCode: ApiErrorCode = artifactStorageFailure?.code ?? "PLATFORM_NOT_READY";
    return {
      app: APP_NAME,
      checks: report.checks,
      ...(!report.ok
        ? {
            code: notReadyCode,
            details: { failedChecks: failedChecks.map(([name]) => name) },
            error: notReadyCode,
            message:
              artifactStorageFailure?.error ??
              `Platform readiness checks failed: ${failedChecks.map(([name]) => name).join(", ")}.`,
            retryable: artifactStorageFailure === null,
          }
        : {}),
      service: "api",
      status: report.ok ? "ready" : "not-ready",
      version: APP_VERSION,
    };
  });

  const metricsEnabled = (process.env.SWIZZLE_METRICS_ENABLED ?? "true") !== "false";
  const metrics = metricsEnabled ? createMetricsRegistry() : null;
  if (metrics !== null) {
    app.get<{ Reply: MetricsResponse }>("/metrics", async (request, reply) => {
      try {
        const summary = await dashboard.getOperabilitySummary(getEnvironment(request));
        for (const queue of summary.queue.queues) {
          metrics.setQueueDepth(queue.name, queue.counts);
        }
      } catch (error) {
        request.log.warn({ err: error }, "Failed to refresh queue depth metric.");
      }
      reply.type(metrics.contentType);
      return await metrics.metrics();
    });
  }

  app.get<{ Reply: OperationsSummaryResponse }>("/ops/summary", async (request) => {
    return await dashboard.getOperationsSummary(getEnvironment(request));
  });

  if (options.workerRegistry !== undefined) {
    registerWorkerRoutes(app, options.workerRegistry, accessStore);
    if (options.dispatch !== undefined)
      registerDispatchRoutes(
        app,
        options.dispatch,
        options.workerRegistry,
        platform.runnerImageChecks,
      );
  }
  registerAccessRoutes(app, { accessStore, auth, environmentStore, platform });
  registerPeopleRoutes(app, { accessStore, auth });
  registerTokenRoutes(app, { accessStore, apiTokenStore, auth });
  registerNotificationRoutes(app, platform);
  registerAutomationFolderRoutes(app, automationFolderStore);
  registerEnvironmentRoutes(app, environmentStore);
  registerDashboardRoutes(app, dashboard, platform);
  registerDeploymentRoutes(app, {
    ...(options.artifactsDirectory !== undefined
      ? { artifactsDirectory: options.artifactsDirectory }
      : {}),
    deploymentUploadRateLimiter,
    platform,
  });
  registerSecretRoutes(app, { platform });
  registerConnectionRoutes(app, { platform });
  registerCredentialRoutes(app, { accessStore, auth, platform });
  registerAutomationRoutes(app, platform);
  registerTimeoutGrantRoutes(app, platform);
  registerRunRoutes(app, platform);
  registerApprovalRoutes(app, { approvalRateLimiter, platform });
  registerEventCallbackRoutes(app, { eventCallbackRateLimiter, platform });
  registerWebhookIngressRoute(app, { platform, webhookIngressLimiter });

  return app;
}

export function registerErrorHandler(app: ApiServer): void {
  app.setNotFoundHandler(() => {
    throw new CodedError("ROUTE_NOT_FOUND", "No such API route.");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ExecutionLeaseError)
      return reply
        .code(API_ERROR_STATUS.EXECUTION_LEASE_INVALID)
        .send({ error: { code: "EXECUTION_LEASE_INVALID", message: error.message } });
    if (error instanceof CodedError || error instanceof AutomationRuntimeError) {
      if (error.code === "WORKER_BUDGET_EXCEEDED") reply.header("Retry-After", "60");
      return reply.status(API_ERROR_STATUS[error.code]).send({
        ...(error.details !== undefined ? { details: error.details } : {}),
        ...(error instanceof CodedError && error.fixCommand !== undefined
          ? { fixCommand: error.fixCommand }
          : {}),
        code: error.code,
        error: error.code,
        message: error.message,
        ...(error.code === "ARTIFACT_STORAGE_NOT_WRITABLE" ? { retryable: false } : {}),
        ...(error.code === "PROJECT_CONTENTS_CHANGED" ? { retryable: true } : {}),
        ...(error.code === "RUN_NOT_FOUND" && typeof error.details?.runId === "string"
          ? { runId: error.details.runId }
          : {}),
      } satisfies ApiErrorResponse);
    }

    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      (error.statusCode < 500 || error.statusCode === 501)
    ) {
      const rawCode = "code" in error && typeof error.code === "string" ? error.code : "";
      const code = isApiErrorCode(rawCode) ? rawCode : "REQUEST_INVALID";
      return reply
        .status(API_ERROR_STATUS[code])
        .send({ code, error: code, message: error.message } satisfies ApiErrorResponse);
    }

    request.log.error({ err: error, reqId: request.id }, "Unhandled server error");
    return reply.status(API_ERROR_STATUS.INTERNAL_SERVER_ERROR).send({
      code: "INTERNAL_SERVER_ERROR",
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error.",
      ...(request.id ? { traceId: request.id } : {}),
    } satisfies ApiErrorResponse);
  });
}

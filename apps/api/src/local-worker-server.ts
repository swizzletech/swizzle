import { createLogger } from "@swizzle/core";
import type { WorkerRegistry } from "@swizzle/db";
import { CodedError } from "@swizzle/db";
import type { ApiTokenStore } from "@swizzle/db/postgres";
import type { ServerDispatch } from "@swizzle/runtime/platform";
import Fastify from "fastify";
import { registerDispatchRoutes } from "./dispatch-routes.js";
import type { ApiServer } from "./http-shared.js";
import { registerErrorHandler } from "./server.js";

/** Bound only to the private worker network. Public ingress rejects the local identity. */
export function buildLocalWorkerServer(
  dispatch: ServerDispatch,
  registry: WorkerRegistry,
  configuredWorkerId: string,
  tokens: ApiTokenStore,
): ApiServer {
  const app: ApiServer = Fastify({
    loggerInstance: createLogger("swizzle-local-worker-api"),
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.decorateRequest("actor", undefined);
  app.addHook("preValidation", async (request) => {
    const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
    const verified = token === undefined ? null : await tokens.verifyToken(token);
    if (verified?.holder.kind !== "worker")
      throw new CodedError("WORKER_FORBIDDEN", "Local worker authentication required.");
    const worker = await registry.authenticate(verified.holder.workerId, verified.id);
    if (worker.kind !== "local" || worker.id !== configuredWorkerId)
      throw new CodedError(
        "WORKER_FORBIDDEN",
        "This listener accepts only the configured local worker.",
      );
    request.actor = { kind: "worker", worker };
  });
  registerErrorHandler(app);
  registerDispatchRoutes(app, dispatch, registry);
  return app;
}

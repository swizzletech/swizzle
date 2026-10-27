import { WORKER_SERVICES } from "@swizzle/config";
import {
  type AccessStore,
  type WorkerGrants,
  type WorkerRegistry,
  workerGroups,
} from "@swizzle/db";
import { AutomationRuntimeError, runImageDiskWarning } from "@swizzle/runtime";
import type {
  WorkerAuditResponse,
  WorkerCredentialResponse,
  WorkerEnrollmentResponse,
  WorkerGroupsResponse,
  WorkerHeartbeatResponse,
  WorkerResponse,
  WorkerSessionResponse,
  WorkersResponse,
} from "@swizzle/runtime/http-contract";
import type { FastifyRequest } from "fastify";
import { clientKey } from "./client-rate-limiter.js";
import { type ApiServer, getEnvironment } from "./http-shared.js";
import { environmentName, objectSchema, uuid } from "./request-validation.js";

const profile = { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" } as const;
const boundedText = { type: "string", minLength: 1, maxLength: 120, pattern: "\\S" } as const;
const noExtras = (properties: Readonly<Record<string, object>>, required: readonly string[]) => ({
  ...objectSchema(properties, required),
  additionalProperties: false,
});

/** Enrollment and identity only. Dispatch consumes the registry's exact-scope session check. */
export function registerWorkerRoutes(
  app: ApiServer,
  registry: WorkerRegistry,
  accessStore: AccessStore,
): void {
  app.get<{ Reply: WorkersResponse }>("/workers", async () => ({
    workers: (await registry.list()).map((worker) => ({
      ...worker,
      runImageDiskWarning:
        worker.runImageDiskOverBudget === null
          ? null
          : runImageDiskWarning(worker.name, worker.runImageDiskOverBudget),
    })),
  }));
  // Discovery for anyone who reads the project: the groups an automation there can name.
  app.get<{ Reply: WorkerGroupsResponse }>("/projects/:project/worker-groups", async (request) => {
    const environment = getEnvironment(request);
    const { project } = request.params as { project: string };
    const { id } = await request.access.project(project, { action: "read", environment });
    return { groups: workerGroups({ projectId: id, environment }, await registry.list()) };
  });
  app.post<{
    Reply: WorkerEnrollmentResponse;
    Body: WorkerGrants & { readonly name: string; readonly capacity?: number };
  }>(
    "/workers/enrollments",
    {
      schema: {
        body: noExtras(
          {
            name: boundedText,
            capacity: { type: "integer", minimum: 1, maximum: 256 },
            services: {
              type: "array",
              maxItems: 1,
              uniqueItems: true,
              items: { enum: [...WORKER_SERVICES] },
            },
            profiles: { type: "array", maxItems: 32, uniqueItems: true, items: profile },
            environments: {
              type: "array",
              maxItems: 64,
              uniqueItems: true,
              items: noExtras({ projectId: uuid, environment: environmentName }, [
                "projectId",
                "environment",
              ]),
            },
          },
          ["name", "profiles", "environments", "services"],
        ),
      },
    },
    async (request) => {
      for (const grant of request.body.environments) {
        if ((await accessStore.getProject(grant.projectId)) === null) {
          throw new AutomationRuntimeError(
            "PROJECT_NOT_FOUND",
            "The worker grant names an unknown project.",
          );
        }
      }
      return await registry.create({
        ...request.body,
        name: request.body.name.trim(),
        issuedBy: personId(request),
      });
    },
  );
  app.delete<{ Reply: WorkerResponse; Params: { workerId: string } }>(
    "/workers/:workerId",
    async (request) => registry.revoke(request.params.workerId, personId(request)),
  );
  app.get<{ Reply: WorkerAuditResponse; Params: { workerId: string } }>(
    "/workers/:workerId/audit",
    async (request) => ({
      events: await registry.audit(request.params.workerId),
    }),
  );
  app.post<{ Reply: WorkerCredentialResponse; Body: { code: string } }>(
    "/worker/enroll",
    {
      bodyLimit: 1024,
      schema: {
        body: noExtras({ code: { type: "string", maxLength: 128, minLength: 1 } }, ["code"]),
      },
    },
    async (request) => registry.enroll(request.body.code, clientKey(request)),
  );
  app.post<{ Reply: WorkerHeartbeatResponse }>(
    "/worker/heartbeat",
    { bodyLimit: 1024, schema: { body: noExtras({}, []) } },
    async (request) => registry.heartbeat(worker(request)),
  );
  app.post<{ Reply: WorkerCredentialResponse; Body: { token: string } }>(
    "/worker/token/renew",
    {
      bodyLimit: 1024,
      schema: {
        body: noExtras({ token: { type: "string", pattern: "^swz_[A-Za-z0-9_-]{43}$" } }, [
          "token",
        ]),
      },
    },
    async (request) => registry.renew(worker(request), request.body.token),
  );
  app.get<{
    Reply: WorkerSessionResponse;
    Querystring: { profile: string; projectId: string; environment: string };
  }>(
    "/worker/session",
    {
      schema: {
        querystring: noExtras({ profile, projectId: uuid, environment: environmentName }, [
          "profile",
          "projectId",
          "environment",
        ]),
      },
    },
    async (request) => ({ worker: await registry.session(worker(request), request.query) }),
  );
}

function personId(request: FastifyRequest): string | null {
  return request.actor?.kind === "person" ? request.actor.userId : null;
}
function worker(request: FastifyRequest) {
  if (request.actor?.kind !== "worker")
    throw new Error("Worker route without worker authentication.");
  return request.actor.worker;
}

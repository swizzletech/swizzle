import type { WorkerRegistry } from "@swizzle/db";
import { CodedError } from "@swizzle/db";
import type { WorkerDispatchResponse } from "@swizzle/runtime/http-contract";
import {
  type ServerDispatch,
  WORKER_ROUTES,
  type WorkerRoute,
  workerBodySchema,
} from "@swizzle/runtime/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiServer } from "./http-shared.js";

export function registerDispatchRoutes(
  app: ApiServer,
  dispatch: ServerDispatch,
  registry: WorkerRegistry,
) {
  const identity = (request: FastifyRequest) => {
    if (request.actor?.kind !== "worker") throw new Error("Worker authentication required.");
    return request.actor.worker;
  };
  // Fastify answers a body outside the route's wire schema with 400 before the handler runs; the
  // handler then reads the body through the same schema, which gives it its type. The two can
  // still disagree, as on string lengths, which JSON Schema counts in code points and zod in UTF-16
  // units, so a body only zod refuses is a 400 too.
  const serve = <Request, Reply>(
    route: WorkerRoute<Request, Reply>,
    handler: (
      body: Request,
      worker: ReturnType<typeof identity>,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<WorkerDispatchResponse<WorkerRoute<Request, Reply>>>,
  ) =>
    app.post(
      route.path,
      {
        ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
        schema: { body: workerBodySchema(route) },
      },
      async (request, reply): Promise<WorkerDispatchResponse<WorkerRoute<Request, Reply>>> => {
        const body = route.request.safeParse(request.body);
        if (!body.success)
          throw new CodedError("REQUEST_BODY_INVALID", `The body does not match ${route.path}.`);
        return await handler(body.data, identity(request), request, reply);
      },
    );
  const accepted = { accepted: true } as const;
  serve(WORKER_ROUTES.preparations, (body, worker) => dispatch.preparations(worker, body.knownIds));
  serve(WORKER_ROUTES.runImage, async (body, worker) => {
    await dispatch.recordRunImage(worker, body.deploymentId, body.tag);
    return accepted;
  });
  serve(WORKER_ROUTES.runImageKeep, async (_body, worker) => ({
    keep: [...(await dispatch.runImageKeep(worker))],
  }));
  serve(WORKER_ROUTES.runtime, async (body, worker) => {
    await registry.heartbeat(worker, body);
    return accepted;
  });
  serve(WORKER_ROUTES.pull, async (_body, worker, _request, reply) => {
    const abort = new AbortController();
    reply.raw.once("close", () => abort.abort());
    return { assignment: await dispatch.pull(worker, abort.signal) };
  });
  serve(WORKER_ROUTES.renew, async (body, worker) => ({
    lease: await dispatch.renew(worker, body.lease),
  }));
  serve(WORKER_ROUTES.source, async (body, worker) => ({
    files: await dispatch.source(worker, body.lease),
  }));
  serve(WORKER_ROUTES.start, async (body, worker) => ({
    secrets: await dispatch.start(worker, body.lease),
  }));
  serve(WORKER_ROUTES.ready, async (body, worker) => {
    await dispatch.ready(worker, body.lease);
    return accepted;
  });
  serve(WORKER_ROUTES.output, async (body, worker) => {
    await dispatch.output(worker, body.lease, body.sequence, body.stream, body.chunk);
    return accepted;
  });
  serve(WORKER_ROUTES.complete, async (body, worker) => {
    await dispatch.complete(worker, body.lease, body.report);
    return accepted;
  });
  serve(WORKER_ROUTES.drain, async (body, worker) => {
    await registry.drain(worker, body.draining);
    return accepted;
  });
}

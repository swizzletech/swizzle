import {
  type AuditActor,
  type AuditStore,
  type AuditTarget,
  auditScope,
  keepAuditValue,
  mergeAuditTarget,
  NO_AUDIT_TARGET,
} from "@swizzle/db";
import { AUDITED_ROUTES, type AuditResponse } from "@swizzle/runtime/http-contract";
import type { FastifyRequest } from "fastify";

import type { ApiServer } from "./http-shared.js";
import { objectSchema, queryInteger, urlText } from "./request-validation.js";

interface RequestAudit {
  target(target: Partial<AuditTarget>, privileged?: boolean): Promise<void>;
  note(details: Readonly<Record<string, unknown>>): Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    audit: RequestAudit;
  }
}

const LINK_PATHS = ["/approvals/:token", "/events/:token"] as const;
const LINK_ROUTES = new Set<string>(LINK_PATHS);
interface Collected {
  target: AuditTarget;
  privileged: boolean;
  details: Record<string, unknown> | null;
  eventId: string | null;
}

export function registerAudit(app: ApiServer, options: { readonly store: AuditStore }): void {
  const { store } = options;
  const collected = new WeakMap<FastifyRequest, Collected>();

  app.addHook("onRequest", (request, _reply, done) => {
    auditScope.run(
      { eventId: null, actor: { kind: "anonymous" }, requestId: String(request.id) },
      done,
    );
  });
  app.decorateRequest("audit", null as unknown as RequestAudit);
  app.addHook("onRequest", async (request) => {
    const entry: Collected = {
      details: null,
      eventId: null,
      privileged: false,
      target: NO_AUDIT_TARGET,
    };
    collected.set(request, entry);
    const describe = async () => {
      if (entry.eventId === null) return;
      await store.describe(entry.eventId, {
        details: entry.details,
        privileged: entry.privileged,
        target: entry.target,
      });
    };
    request.audit = {
      async note(details) {
        entry.details = { ...entry.details, ...details };
        await describe();
      },
      async target(target, privileged = false) {
        entry.target = mergeAuditTarget(entry.target, target, keepAuditValue);
        entry.privileged ||= privileged;
        await describe();
      },
    };
  });

  app.addHook("preHandler", async (request) => {
    const scope = auditScope.getStore();
    if (scope !== undefined) scope.actor = auditActor(request);
    if (!changes(request)) return;
    const entry = collected.get(request);
    if (entry === undefined) return;
    entry.eventId = await begin(request, entry);
    if (scope !== undefined) scope.eventId = entry.eventId;
  });

  const begin = (request: FastifyRequest, entry: Collected) =>
    store.begin({
      action: action(request),
      actor: auditActor(request),
      details: entry.details,
      params: params(request),
      privileged: entry.privileged,
      requestId: String(request.id),
      target: entry.target,
    });

  const auditQuery = {
    schema: {
      querystring: objectSchema({
        actor: urlText,
        automation: urlText,
        environment: urlText,
        worker: urlText,
        before: urlText,
        limit: queryInteger,
      }),
    },
  };
  app.get<{ Reply: AuditResponse }>("/audit", auditQuery, async (request) => {
    const query = request.query as {
      actor?: string;
      automation?: string;
      environment?: string;
      worker?: string;
      before?: string;
      limit?: string;
    };
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    const view = await request.access.auditView();
    const actor = view.ownOnly ? (actorId(request) ?? "") : query.actor;
    let environments = view.environments;
    if (query.environment !== undefined) {
      if (view.environments === null || view.environments.includes(query.environment)) {
        environments = [query.environment];
      } else {
        environments = [];
      }
    }
    const events = await store.list({
      environments,
      projectIds: view.projectIds,
      ...(actor !== undefined ? { actorId: actor } : {}),
      ...(query.automation !== undefined ? { automation: query.automation } : {}),
      ...(query.worker !== undefined ? { workerId: query.worker } : {}),
      ...(query.before !== undefined ? { before: query.before } : {}),
      limit,
    });
    return { events, next: events.length === limit ? (events.at(-1)?.id ?? null) : null };
  });

  app.addHook("onResponse", async (request, reply) => {
    const entry = collected.get(request);
    if (entry === undefined) return;
    try {
      if (entry.eventId !== null) {
        await store.finish(entry.eventId, reply.statusCode);
      } else if (changes(request) && (request.actor !== undefined || isLink(request))) {
        await store.finish(await begin(request, entry), reply.statusCode);
      }
    } catch (error) {
      request.log.error({ err: error }, "Could not complete the audit event.");
    }
  });
}

function actorId(request: FastifyRequest): string | null {
  const actor = request.actor;
  if (actor?.kind === "person") return actor.userId;
  if (actor?.kind === "service-account") return actor.serviceAccountId;
  return null;
}

function changes(request: FastifyRequest): boolean {
  const url = request.routeOptions.url;
  return url !== undefined && AUDITED_ROUTES.has(`${request.method} ${url}`);
}

function isLink(request: FastifyRequest): boolean {
  return LINK_ROUTES.has(request.routeOptions.url ?? "");
}

function action(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url ?? request.url}`;
}

function params(request: FastifyRequest): Record<string, string> {
  const raw = (request.params ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).flatMap(([name, value]) =>
      name === "token" || typeof value !== "string" ? [] : [[name, value]],
    ),
  );
}

function auditActor(request: FastifyRequest): AuditActor {
  const actor = request.actor;
  if (actor === undefined) return { kind: isLink(request) ? "link" : "anonymous" };
  switch (actor.kind) {
    case "person":
      return {
        kind: "person",
        label: actor.label,
        role: actor.role,
        tokenId: actor.token?.id ?? null,
        userId: actor.userId,
      };
    case "service-account":
      return {
        kind: "service-account",
        label: actor.label,
        serviceAccountId: actor.serviceAccountId,
        tokenId: actor.token.id,
      };
    case "worker":
      return { kind: "worker", workerId: actor.worker.id, label: actor.worker.name };
  }
}

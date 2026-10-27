/**
 * The audit (packages/db/src/audit.ts) at the HTTP boundary. Every request that may change
 * something, which is every route `ROUTE_POLICY` (http-contract.ts) marks `audit`, plus the
 * approval and event links, writes its event before its handler runs and completes it with the
 * status it ended with. A request whose event cannot be written fails before it changes anything.
 * One refused before its handler, by the instance check or the body's schema, is recorded
 * afterwards.
 *
 * The access check (request-access.ts) tells the event what the request is about: the first
 * automation, run, project or credential it resolves. A route adds what the check cannot see with
 * `await request.audit.note(...)`. Both are written to the event as soon as they are known, so
 * they are durable before the handler changes anything. A read creates no event, not even one
 * that only an owner's or admin's instance role allowed, and neither does a deployment check.
 *
 * `GET /audit` reads the events, newest first, as far as `auditView` (packages/db/src/access.ts)
 * lets the actor. The events name the automation by id and slug without a foreign key, so they
 * outlive its deletion.
 */
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
  /** What the request is about; a field already known keeps its first value. */
  target(target: Partial<AuditTarget>, privileged?: boolean): Promise<void>;
  /**
   * Facts the route adds to its event, such as the reason for a reassignment. Await it before the
   * change: it fails the request when the event cannot be written.
   */
  note(details: Readonly<Record<string, unknown>>): Promise<void>;
}

declare module "fastify" {
  interface FastifyRequest {
    audit: RequestAudit;
  }
}

/** Public routes that change a run: whoever holds the link acts. */
const LINK_PATHS = ["/approvals/:token", "/events/:token"] as const;
const LINK_ROUTES = new Set<string>(LINK_PATHS);
interface Collected {
  target: AuditTarget;
  privileged: boolean;
  details: Record<string, unknown> | null;
  eventId: string | null;
}

/** Register after the auth guard, so the event knows the actor. */
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
    // Before the event exists the facts wait in `entry`, and `begin` writes them.
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
        // Refused before its handler ran, so it changed nothing: recorded after the fact.
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

/** The path parameters, except a link's token, which is a capability. */
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

/**
 * The policy (packages/db/src/access.ts) at the HTTP boundary. Every route states its rule in
 * ROUTE_ACCESS; the auth guard checks worker credentials on "worker" routes and lets "public"
 * routes through. This module refuses "instance" routes
 * to anyone but an instance owner or admin, and a "resource" route asks `request.access` about the
 * resource it names before it answers. A route missing from the table fails at registration, and a
 * "resource" route that answers without asking fails closed with a 500.
 *
 * The owner of a resource comes from its record, never from the request: a run's automation, an
 * automation's project. Unknown and invisible resources answer the same 404; a visible resource the
 * actor may not change answers 403 ACCESS_DENIED with the actor's role and where it comes from.
 * The grants are read once per request, so a revoked grant takes effect on the next one.
 */
import {
  type AccessGrants,
  type AccessRefusal,
  type AccessStore,
  type AccessTarget,
  type AuditTarget,
  type AuditView,
  type AutomationFolder,
  type AutomationOwner,
  approvalRights,
  auditView,
  byInstanceRoleAlone,
  CodedError,
  type CredentialKind,
  type CredentialPlace,
  type CredentialRight,
  credentialRight,
  DEFAULT_PROJECT_ID,
  type Decision,
  type DeploymentCredential,
  decide,
  environmentRole,
  getRunApproval,
  type InstanceRole,
  isInstanceOperator,
  mayUseCredential,
  type Need,
  PROJECT_ROLES,
  type ProjectRole,
  projectRole,
  type ReadScope,
  type RegisteredWorker,
  type RunApproval,
  reachedProjects,
  readScope,
  refusalOf,
  type StoredCredential,
  type StoredProject,
  type Subject,
  type TokenScope,
} from "@swizzle/db";
import type { ApiTokenStore, AutomationFolderStore, SwizzleAuth } from "@swizzle/db/postgres";
import { AutomationRuntimeError } from "@swizzle/runtime";
import { ROUTE_ACCESS, type RouteAccess } from "@swizzle/runtime/http-contract";
import type {
  PlatformRunDetail,
  PlatformRunRecord,
  PlatformServices,
} from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";

import type { ApiServer } from "./http-shared.js";

/** The token a request came with: what caps it, and what `fresh()` checks again. */
interface ActingToken {
  readonly id: string;
  readonly name: string;
  readonly scope: TokenScope;
}

/**
 * Who sent a request: a person by session (token null) or agent token, a service account by
 * its token, or a worker with its independent protocol identity.
 */
export type Actor =
  | { readonly kind: "worker"; readonly worker: RegisteredWorker }
  | {
      readonly kind: "person";
      readonly userId: string;
      /** The email, as the audit and a decided approval name the person. */
      readonly label: string;
      readonly role: InstanceRole;
      readonly token: ActingToken | null;
    }
  | {
      readonly kind: "service-account";
      readonly serviceAccountId: string;
      readonly label: string;
      readonly projectId: string;
      readonly token: ActingToken;
    };

/** The grant subject an actor is, to give a credential's creator manage; null for a worker. */
function actorSubject(actor: Actor | undefined): Subject | null {
  if (actor === undefined || actor.kind === "worker") return null;
  return actor.kind === "person"
    ? { kind: "user", userId: actor.userId }
    : { kind: "service-account", serviceAccountId: actor.serviceAccountId };
}

/** `{ creator }` for an actor a credential can name, else nothing. */
export function creatorOf(request: FastifyRequest): { readonly creator?: Subject } {
  const creator = actorSubject(request.actor);
  return creator === null ? {} : { creator };
}

interface ApprovalRights {
  readonly decide: boolean;
  readonly reassign: boolean;
}

interface RequestAccess {
  /** The automation once the actor may do `need` to it; 404 AUTOMATION_NOT_FOUND when they may not see it. */
  automation(automationName: string, need: Need): Promise<AutomationOwner>;
  /**
   * The run once the actor may do `action` in the run's own project and environment, which stay
   * the run's after its automation moves or is deleted; 404 RUN_NOT_FOUND when invisible.
   */
  run(runId: string, action: "read" | "run"): Promise<PlatformRunDetail>;
  /** The folder once the actor may organize its project; 404 FOLDER_NOT_FOUND when invisible. */
  folder(folderId: string): Promise<AutomationFolder>;
  /** The projects the actor holds a project role in, or "all" for an instance owner or admin. */
  projects(): Promise<readonly string[] | "all">;
  /** What of the audit the actor reads (`auditView`). */
  auditView(): Promise<AuditView>;
  /** Whether the actor operates the instance: an owner or admin with a full-scope token or none. */
  operatesInstance(): Promise<boolean>;
  /** The person and their teams, whom an approval can be assigned to. */
  subjects(): Promise<readonly Subject[]>;
  /**
   * The project once the actor may do `need` to it as such; 404 PROJECT_NOT_FOUND when invisible.
   * `named` adds what the request itself names inside the project, such as the environment of a
   * grant, to the audit's target of a visible project, allowed or refused.
   */
  project(reference: string, need: Need, named?: Partial<AuditTarget>): Promise<StoredProject>;
  /** The automations a list may show in `environment`. */
  scope(environment: string): Promise<ReadScope>;
  /**
   * Why the actor may not do `need` to a target they read, as its 403 would say; null when they
   * may. The dashboard leaves out a control it refuses and says this instead.
   */
  refusal(target: AccessTarget, need: Need): Promise<AccessRefusal | null>;
  /** The actor's role in a project as such, before any environment caps it; null for none. */
  role(projectId: string): Promise<ProjectRole | null>;
  /** The same role after `environment` caps it. */
  roleIn(projectId: string, environment: string): Promise<ProjectRole | null>;
  /**
   * The project a deployment lands in, once the actor may edit the automation there. An existing
   * automation stays in its project; a new one joins `requested`, or the default project.
   */
  place(
    automation: { readonly automationSlug: string; readonly current: AutomationOwner | null },
    requested: string | undefined,
    environment: string,
  ): Promise<string>;
  /**
   * Why `place` refuses a new automation that names no project, as the empty Overview says before
   * the first deploy; null when it lands.
   */
  placeRefusal(environment: string): Promise<AccessRefusal | null>;
  /**
   * The credential once the actor holds `right` on it. 404 SECRET_NOT_FOUND or
   * CONNECTION_NOT_FOUND when it does not exist, or the actor can neither read its place nor holds
   * a right on it; 403 ACCESS_DENIED when they see it but lack the right.
   */
  credential(
    kind: CredentialKind,
    name: string,
    place: CredentialPlace,
    right: CredentialRight,
  ): Promise<StoredCredential>;
  /** The actor's right on each credential, in the order given, for a list. */
  credentialRights(
    credentials: readonly StoredCredential[],
  ): Promise<readonly (CredentialRight | null)[]>;
  /**
   * Refuses with 403 CREDENTIAL_USE_DENIED, naming each credential the actor may not bind in a
   * deployment to `projectId`.
   */
  useCredentials(credentials: readonly DeploymentCredential[], projectId: string): Promise<void>;
  /**
   * The run and its open approval at `stepKey`, with what the actor may do with it
   * (`approvalRights`). 404 RUN_NOT_FOUND when the run is invisible; 409 RUN_EVENT_NOT_WAITING
   * when it does not wait for that approval.
   */
  approval(
    runId: string,
    stepKey: string,
  ): Promise<{
    readonly run: PlatformRunRecord;
    readonly approval: RunApproval;
    readonly may: ApprovalRights;
  }>;
  /**
   * What the actor may do with an open approval of a run they can read. Only a person with a
   * session decides; a token never does.
   */
  approvalRights(
    run: AccessTarget & { readonly environment: string },
    approval: RunApproval,
  ): Promise<ApprovalRights>;
  /** The same questions with the grants read again, for a request that outlives a revocation. */
  fresh(): RequestAccess;
}

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
    access: RequestAccess;
  }
}

export interface RegisterAccessOptions {
  readonly accessStore: AccessStore;
  /** Re-reads a person for `fresh()`, so a demotion, suspension or removal reaches a long-lived request. */
  readonly auth: Pick<SwizzleAuth, "findPerson">;
  /** Re-checks a token for `fresh()`, so a revocation or expiry reaches a long-lived request too. */
  readonly tokens: Pick<ApiTokenStore, "isLive">;
  readonly folders: Pick<AutomationFolderStore, "getFolder">;
  readonly platform: PlatformServices;
}

/** The rule of the route a request matched; a request no route matched needs a signed-in actor. */
export function routeAccess(request: FastifyRequest): RouteAccess {
  const url = request.routeOptions.url;
  if (url === undefined) return "signed-in";
  return ROUTE_ACCESS[routeKey(request.method, url)] ?? "signed-in";
}

/** Register before any route, so the check sees every one. */
export function registerAccess(app: ApiServer, options: RegisterAccessOptions): void {
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      const key = routeKey(method, route.url);
      if (ROUTE_ACCESS[key] === undefined) {
        throw new Error(
          `${key} has no entry in ROUTE_ACCESS (packages/runtime/src/http-contract.ts).`,
        );
      }
    }
  });

  const asked = new WeakSet<FastifyRequest>();
  app.decorateRequest("access", null as unknown as RequestAccess);
  app.addHook("onRequest", async (request) => {
    request.access = createRequestAccess(
      async () => request.actor,
      options,
      () => asked.add(request),
      (target, privileged) => request.audit.target(target, privileged),
    );
  });

  // Runs after the auth guard's preValidation, which has settled `request.actor`.
  app.addHook("preValidation", async (request) => {
    if (routeAccess(request) !== "instance") return;
    const actor = request.actor;
    // Operating the instance depends on the instance role and the token's scope alone.
    if (
      actor?.kind === "person" &&
      isInstanceOperator({
        ...NO_GRANTS,
        instanceRole: actor.role,
        scope: actor.token?.scope ?? null,
      })
    ) {
      return;
    }
    const scoped = actor !== undefined && actor.kind !== "worker" && actor.token !== null;
    throw new CodedError(
      "ACCESS_DENIED",
      scoped
        ? "Only an instance owner or admin may do this, with a session or a token of full scope."
        : "Only an instance owner or admin may do this.",
      {
        details: {
          required: "admin",
          role: actor?.kind === "person" ? actor.role : null,
          scope: scoped ? actor.token?.scope : null,
        },
      },
    );
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (routeAccess(request) === "resource" && reply.statusCode < 400 && !asked.has(request)) {
      request.log.error({ route: request.routeOptions.url }, "Resource route answered unchecked.");
      throw new Error("A resource route answered without an access check.");
    }
    return payload;
  });
}

/**
 * What a check resolved, for the request's audit event (request-audit.ts): an allowed one, and a
 * refused one the actor may know about. A target the actor may not see never reaches the audit.
 */
type Reached = (target: Partial<AuditTarget>, privileged: boolean) => Promise<void>;

function createRequestAccess(
  actor: () => Promise<Actor | undefined>,
  options: RegisterAccessOptions,
  markAsked: () => void,
  reached: Reached,
): RequestAccess {
  const { accessStore, auth, folders, platform } = options;
  let loaded: Promise<AccessGrants> | undefined;
  const grants = () => {
    markAsked();
    loaded ??= actor().then((current) => grantsOf(current, accessStore));
    return loaded;
  };

  /**
   * `found` once the actor may do `need` to its target: 404 by `notFound` when it is missing or
   * invisible, 403 when visible. Either outcome the actor may know names its target in the audit.
   */
  const permit = async <T>(
    found: T | null,
    check: (found: T) => {
      readonly target: AccessTarget;
      readonly need: Need;
      readonly audited: Partial<AuditTarget>;
    },
    notFound: () => AutomationRuntimeError,
  ): Promise<T> => {
    if (found === null) throw notFound();
    const access = await grants();
    const { audited, need, target } = check(found);
    const decision = decide(access, need, target);
    if (!decision.allowed && !decision.visible) throw notFound();
    await reached(audited, decision.allowed && byInstanceRoleAlone(access, need, target));
    if (!decision.allowed) throw denied(decision);
    return found;
  };

  const access: RequestAccess = {
    async automation(automationName, need) {
      return await permit(
        await platform.findAutomation(automationName),
        (owner) => ({
          audited: { ...owner, environment: "environment" in need ? need.environment : null },
          need,
          target: owner,
        }),
        () =>
          new AutomationRuntimeError(
            "AUTOMATION_NOT_FOUND",
            `Automation not found: ${automationName}`,
          ),
      );
    },

    async run(runId, action) {
      return await permit(
        await platform.getPlatformRun(runId),
        (run) => ({
          audited: {
            automationId: run.automationId,
            automationSlug: run.automationSlug,
            environment: run.environment,
            projectId: run.projectId,
            runId: run.runId,
          },
          need: { action, environment: run.environment },
          target: run,
        }),
        () =>
          new AutomationRuntimeError("RUN_NOT_FOUND", `Run not found: ${runId}`, {
            details: { runId },
          }),
      );
    },

    async approval(runId, stepKey) {
      const run = await access.run(runId, "read");
      const approval = getRunApproval(run);
      if (approval === null || approval.stepKey !== stepKey) {
        throw new AutomationRuntimeError(
          "RUN_EVENT_NOT_WAITING",
          `Run ${runId} is not waiting for the approval ${stepKey}.`,
          { details: { runId, stepKey } },
        );
      }
      return { approval, may: await access.approvalRights(run, approval), run };
    },

    async approvalRights(run, approval) {
      const current = await actor();
      const rights = approvalRights(await grants(), approval.assignee, run);
      const human = current?.kind === "person" && current.token === null;
      return { decide: human && rights.decide, reassign: human && rights.reassign };
    },

    async folder(folderId) {
      return await permit(
        await folders.getFolder(folderId),
        (folder) => ({
          audited: { projectId: folder.projectId },
          need: { action: "organize" },
          target: { automationId: null, projectId: folder.projectId },
        }),
        () => new AutomationRuntimeError("FOLDER_NOT_FOUND", `Folder not found: ${folderId}`),
      );
    },

    async projects() {
      return reachedProjects(await grants());
    },

    async auditView() {
      return auditView(await grants());
    },

    async operatesInstance() {
      return isInstanceOperator(await grants());
    },

    async subjects() {
      return (await grants()).subjects;
    },

    async project(reference, need, named = {}) {
      return await permit(
        await accessStore.getProject(reference),
        (project) => ({
          audited: {
            environment: "environment" in need ? need.environment : null,
            ...named,
            projectId: project.id,
          },
          need,
          target: { automationId: null, projectId: project.id },
        }),
        () => new AutomationRuntimeError("PROJECT_NOT_FOUND", `Project not found: ${reference}`),
      );
    },

    async scope(environment) {
      return readScope(await grants(), environment);
    },

    async refusal(target, need) {
      const decision = decide(await grants(), need, target);
      return decision.allowed ? null : refusalOf(decision);
    },

    async role(projectId) {
      return projectRole(await grants(), projectId);
    },

    async roleIn(projectId, environment) {
      return environmentRole(await grants(), projectId, environment);
    },

    async credential(kind, name, place, right) {
      const access = await grants();
      const stored = await platform.credentials.findCredential(kind, name, place);
      const [held] = stored === null ? [] : await platform.credentials.credentialAccess([stored]);
      const owner = { automationId: null, projectId: place.projectId };
      const visible =
        held !== undefined &&
        (decide(access, { action: "read", environment: place.environment }, owner).allowed ||
          credentialRight(access, held.credential, held.grants) !== null);
      if (stored === null || held === undefined || !visible) {
        throw new AutomationRuntimeError(
          kind === "secret" ? "SECRET_NOT_FOUND" : "CONNECTION_NOT_FOUND",
          `${kind === "secret" ? "Secret" : "Connection"} not found in environment ${place.environment}: ${name}`,
        );
      }
      // Whether a right on the credential falls short of the one asked for.
      const short = (holds: CredentialRight | null) =>
        holds !== "manage" && (right === "manage" || holds === null);
      const holds = credentialRight(access, held.credential, held.grants);
      if (short(holds)) {
        await reached(place, false);
        throw new AutomationRuntimeError(
          "ACCESS_DENIED",
          `This needs ${right} on ${kind} ${name}; you have ${holds ?? "no right"} on it.`,
          { details: { credential: { kind, name }, required: right, right: holds } },
        );
      }
      await reached(
        place,
        isInstanceOperator(access) &&
          short(
            credentialRight({ ...access, instanceRole: "member" }, held.credential, held.grants),
          ),
      );
      return stored;
    },

    async credentialRights(credentials) {
      const access = await grants();
      const held = await platform.credentials.credentialAccess(credentials);
      return held.map(({ credential, grants }) => credentialRight(access, credential, grants));
    },

    async useCredentials(credentials, projectId) {
      const access = await grants();
      const held = await platform.credentials.credentialAccess(
        credentials.map(({ credential }) => credential),
      );
      const refused = held.flatMap(({ credential, grants }) =>
        mayUseCredential(access, credential, grants, projectId)
          ? []
          : [{ kind: credential.kind, name: credential.name }],
      );
      if (refused.length > 0) {
        throw new AutomationRuntimeError(
          "CREDENTIAL_USE_DENIED",
          `This version uses credentials you may not use: ${refused.map(({ kind, name }) => `${kind} ${name}`).join(", ")}. Someone who manages them can grant you use.`,
          { details: { credentials: refused } },
        );
      }
    },

    async placeRefusal(environment) {
      return await access.refusal(
        { automationId: null, projectId: DEFAULT_PROJECT_ID },
        { action: "edit", environment },
      );
    },

    async place({ automationSlug, current }, requested, environment) {
      if (current === null) {
        const project = await access.project(requested ?? DEFAULT_PROJECT_ID, {
          action: "edit",
          environment,
        });
        // A new automation has no id before the deploy commits; its slug names it in the audit.
        await reached({ automationSlug }, false);
        return project.id;
      }
      const decision = decide(await grants(), { action: "edit", environment }, current);
      if (!decision.allowed && !decision.visible) {
        // Automation names are unique across projects, so the name alone is what this reveals.
        throw new AutomationRuntimeError(
          "AUTOMATION_PROJECT_MISMATCH",
          `The name ${automationSlug} belongs to an automation in a project you cannot see. Rename the automation.`,
        );
      }
      if (!decision.allowed) {
        await reached({ ...current, environment }, false);
        throw denied(decision);
      }
      if (requested !== undefined) {
        const project = await access.project(requested, { action: "read", environment });
        if (project.id !== current.projectId) {
          throw new AutomationRuntimeError(
            "AUTOMATION_PROJECT_MISMATCH",
            `Automation ${automationSlug} belongs to another project. Deploying does not move it: \`swizzle move ${automationSlug} --project <project>\`.`,
          );
        }
      }
      await reached(
        { ...current, environment },
        byInstanceRoleAlone(await grants(), { action: "edit", environment }, current),
      );
      return current.projectId;
    },

    fresh() {
      return createRequestAccess(
        async () => {
          const current = await actor();
          if (current === undefined || current.kind === "worker") return current;
          if (current.token !== null && !(await options.tokens.isLive(current.token.id))) {
            return undefined;
          }
          if (current.kind === "service-account") return current;
          const person = await auth.findPerson(current.userId);
          return person === null || person.suspended
            ? undefined
            : { ...current, role: person.role };
        },
        options,
        markAsked,
        reached,
      );
    },
  };
  return access;
}

const NO_GRANTS: AccessGrants = {
  grants: [],
  instanceRole: "member",
  protectedEnvironments: [],
  scope: null,
  subjects: [],
};

/** What the policy knows about an actor, capped by the scope of the token they came with. */
async function grantsOf(actor: Actor | undefined, accessStore: AccessStore): Promise<AccessGrants> {
  if (actor === undefined || actor.kind === "worker") return NO_GRANTS;
  const grants = await accessStore.loadGrants(
    actor.kind === "person"
      ? { instanceRole: actor.role, kind: "user", userId: actor.userId }
      : actor,
  );
  return { ...grants, scope: actor.token?.scope ?? null };
}

function denied(decision: Extract<Decision, { allowed: false }>): AutomationRuntimeError {
  const role = decision.role ?? "no role";
  const { protectedEnvironment, scope } = decision;
  const protection =
    protectedEnvironment === null
      ? ""
      : ` The ${protectedEnvironment} environment is protected in this project, so only a ${protectedEnvironment} grant counts there. Ask an admin of the project to grant you ${protectedEnvironment}, or an owner or admin of the instance to add you to a team that holds it.`;
  return new AutomationRuntimeError(
    "ACCESS_DENIED",
    `This needs ${decision.required}; you have ${role} here${scope === null ? "" : ` with this token${scopeLimits(scope, decision.required)}`}.${protection}`,
    { details: refusalOf(decision) },
  );
}

/** What a token's scope limits, as a clause of a refusal: ", which allows at most viewer and reaches only staging". */
function scopeLimits(scope: TokenScope, required: ProjectRole): string {
  const limits = [
    ...(PROJECT_ROLES.indexOf(scope.role) < PROJECT_ROLES.indexOf(required)
      ? [`allows at most ${scope.role}`]
      : []),
    ...(scope.environments === null ? [] : [`reaches only ${scope.environments.join(", ")}`]),
  ];
  return limits.length === 0 ? "" : `, which ${limits.join(" and ")}`;
}

function routeKey(method: string, url: string): string {
  return `${method === "HEAD" ? "GET" : method} ${url}`;
}

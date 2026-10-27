/**
 * Who may use and manage a credential, a secret or a connection, over HTTP. Anyone with a right on
 * a credential reads who holds one and why. Someone who manages it grants use or manage to a
 * person, team or service account of its project and offers it to another project; an admin of
 * that project accepts the share, and from then deployments there may bind it. What a right allows
 * is decided in packages/db/src/access.ts, never here.
 */
import {
  type AccessStore,
  CodedError,
  CREDENTIAL_RIGHTS,
  type CredentialKind,
  type CredentialPlace,
  type CredentialRight,
  credentialHolders,
  DEFAULT_PROJECT_ID,
  loadHolderDirectory,
  type StoredCredential,
} from "@swizzle/db";
import type { SwizzleAuth } from "@swizzle/db/postgres";
import type {
  CredentialAccessResponse,
  CredentialShareResponse,
  CredentialSharesResponse,
  NoContentResponse,
  SharedCredentialsResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";

import { type SubjectQuery, subjectFields, subjectNamed } from "./access-routes.js";
import { type ApiServer, getEnvironment, requestValidationError } from "./http-shared.js";
import { objectSchema, urlText } from "./request-validation.js";

export interface RegisterCredentialRoutesOptions {
  readonly accessStore: AccessStore;
  readonly auth: SwizzleAuth;
  readonly platform: PlatformServices;
}

/** `?project=` by slug or id, the default project when absent. */
interface CredentialQuery {
  readonly project?: string;
}

const projectQuery = { schema: { querystring: objectSchema({ project: urlText }) } };

/**
 * The project and environment a secret or connection request names, once the caller may read
 * there: `?project=` and `?environment=`.
 */
export async function credentialPlace(request: FastifyRequest): Promise<CredentialPlace> {
  const environment = getEnvironment(request);
  const { project } = request.query as CredentialQuery;
  const { id } = await request.access.project(project ?? DEFAULT_PROJECT_ID, {
    action: "read",
    environment,
  });
  return { environment, projectId: id };
}

export function registerCredentialRoutes(
  app: ApiServer,
  options: RegisterCredentialRoutesOptions,
): void {
  const { platform } = options;
  // A service account is named among those of the credential's own project.
  const subjectOf = (query: SubjectQuery, credential: StoredCredential) =>
    subjectNamed(options, query, credential.projectId).then((named) => named.subject);

  /** The credential the path names, once the caller manages it. */
  const managed = async (request: FastifyRequest): Promise<StoredCredential> => {
    const { kind, name } = request.params as { kind: CredentialKind; name: string };
    return await request.access.credential(kind, name, await credentialPlace(request), "manage");
  };

  const administered = async (request: FastifyRequest) => {
    const { project } = request.params as { project: string };
    return await request.access.project(project, { action: "administer" });
  };

  // Anyone with a right on the credential sees who else holds one; only a manager changes that.
  app.get<{ Reply: CredentialAccessResponse }>(
    "/credentials/:kind/:name/access",
    projectQuery,
    async (request) => {
      const { kind, name } = request.params as { kind: CredentialKind; name: string };
      const credential = await request.access.credential(
        kind,
        name,
        await credentialPlace(request),
        "use",
      );
      const [[access], [right], directory] = await Promise.all([
        platform.credentials.credentialAccess([credential]),
        request.access.credentialRights([credential]),
        loadHolderDirectory(
          { accessStore: options.accessStore, people: options.auth },
          credential.projectId,
        ),
      ]);
      // request.access.credential refused a caller without a right, and the credential exists.
      if (access === undefined || right === undefined || right === null || directory === null) {
        throw new Error(`The access of ${kind} ${name} vanished while it was read.`);
      }
      return {
        credential,
        grants: access.grants,
        holders: credentialHolders(directory, credential, access.grants),
        right,
        serviceAccounts: directory.serviceAccounts.map((account) => ({
          id: account.id,
          name: account.name,
        })),
        shares: access.shares,
      };
    },
  );

  const grantBody = {
    schema: {
      body: objectSchema(
        { ...subjectFields, right: { enum: [...CREDENTIAL_RIGHTS], type: "string" } },
        ["right"],
      ),
      querystring: objectSchema({ project: urlText }),
    },
  };
  app.put<{ Reply: NoContentResponse }>(
    "/credentials/:kind/:name/grants",
    grantBody,
    async (request, reply) => {
      const credential = await managed(request);
      const body = request.body as SubjectQuery & { right: CredentialRight };
      await platform.credentials.setCredentialGrant(credential, {
        right: body.right,
        subject: await subjectOf(body, credential),
      });
      return reply.status(204).send();
    },
  );

  const subjectQuery = {
    schema: { querystring: objectSchema({ ...subjectFields, project: urlText }) },
  };
  app.delete<{ Reply: NoContentResponse }>(
    "/credentials/:kind/:name/grants",
    subjectQuery,
    async (request, reply) => {
      const credential = await managed(request);
      const removed = await platform.credentials.removeCredentialGrant(
        credential,
        await subjectOf(request.query as SubjectQuery, credential),
      );
      if (!removed) throw new CodedError("GRANT_NOT_FOUND", "No such grant.");
      return reply.status(204).send();
    },
  );

  // The offer is accepted at once when the caller administers the receiving project too.
  app.put<{ Reply: CredentialShareResponse }>(
    "/credentials/:kind/:name/shares/:project",
    projectQuery,
    async (request) => {
      const credential = await managed(request);
      const target = await sharedTo(request, credential);
      const accepted =
        (await request.access.projects()) === "all" ||
        (await request.access.role(target)) === "admin";
      return await platform.credentials.offerCredentialShare({
        accepted,
        credential,
        offeredBy: personOf(request),
        projectId: target,
      });
    },
  );

  app.delete<{ Reply: NoContentResponse }>(
    "/credentials/:kind/:name/shares/:project",
    projectQuery,
    async (request, reply) => {
      const credential = await managed(request);
      const target = await sharedTo(request, credential);
      const [access] = await platform.credentials.credentialAccess([credential]);
      const share = access?.shares.find((candidate) => candidate.project.id === target);
      if (
        share === undefined ||
        !(await platform.credentials.removeCredentialShare(share.shareId))
      ) {
        throw new CodedError("SHARE_NOT_FOUND", "No such share.");
      }
      return reply.status(204).send();
    },
  );

  app.get<{ Reply: CredentialSharesResponse }>(
    "/projects/:project/credential-shares",
    async (request) => {
      const project = await administered(request);
      return { shares: await platform.credentials.listCredentialShares(project.id) };
    },
  );

  // The project's credentials in the environment that the caller manages, with their shares.
  app.get<{ Reply: SharedCredentialsResponse }>(
    "/projects/:project/shared-credentials",
    async (request) => {
      const environment = getEnvironment(request);
      const { project } = request.params as { project: string };
      const { id } = await request.access.project(project, { action: "read", environment });
      const [secrets, connections] = await Promise.all([
        platform.listSecrets(environment, [id]),
        platform.listConnections(environment, [id]),
      ]);
      const owned = [
        ...secrets.map((secret) => storedCredential("secret", secret)),
        ...connections.map((connection) => storedCredential("connection", connection)),
      ];
      const rights = await request.access.credentialRights(owned);
      const managed = owned.filter((_, index) => rights[index] === "manage");
      const accesses = await platform.credentials.credentialAccess(managed);
      const shares = accesses.flatMap((access) => access.shares);
      return {
        credentials: managed.map((credential) => ({
          credential,
          shares: shares.filter(
            (share) =>
              share.credential.kind === credential.kind && share.credential.id === credential.id,
          ),
        })),
      };
    },
  );

  app.put<{ Reply: CredentialShareResponse }>(
    "/projects/:project/credential-shares/:shareId",
    async (request) => {
      const project = await administered(request);
      const { shareId } = request.params as { shareId: string };
      const share = await platform.credentials.acceptCredentialShare({
        acceptedBy: personOf(request),
        projectId: project.id,
        shareId,
      });
      if (share === null) throw new CodedError("SHARE_NOT_FOUND", "No such share.");
      return share;
    },
  );

  app.delete<{ Reply: NoContentResponse }>(
    "/projects/:project/credential-shares/:shareId",
    async (request, reply) => {
      const project = await administered(request);
      const { shareId } = request.params as { shareId: string };
      const shares = await platform.credentials.listCredentialShares(project.id);
      if (
        !shares.some((share) => share.shareId === shareId) ||
        !(await platform.credentials.removeCredentialShare(shareId))
      ) {
        throw new CodedError("SHARE_NOT_FOUND", "No such share.");
      }
      return reply.status(204).send();
    },
  );
}

/** A listed secret or connection as the credential it is, without its other fields. */
function storedCredential(
  kind: CredentialKind,
  listed: Omit<StoredCredential, "kind">,
): StoredCredential {
  return {
    environment: listed.environment,
    id: listed.id,
    kind,
    name: listed.name,
    projectId: listed.projectId,
  };
}

/** The project a share path names, which the caller must see; never the credential's own. */
async function sharedTo(request: FastifyRequest, credential: StoredCredential): Promise<string> {
  const { project } = request.params as { project: string };
  const target = await request.access.project(project, {
    action: "read",
    environment: credential.environment,
  });
  if (target.id === credential.projectId) {
    return requestValidationError("A credential is already usable in its own project.");
  }
  return target.id;
}

function personOf(request: FastifyRequest): string | null {
  return request.actor?.kind === "person" ? request.actor.userId : null;
}

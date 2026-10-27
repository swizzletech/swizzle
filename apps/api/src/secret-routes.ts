import { CodedError } from "@swizzle/db";
import type {
  NoContentResponse,
  SecretResponse,
  SecretsResponse,
  SetSecretResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";

import { credentialPlace } from "./credential-routes.js";
import {
  type ApiServer,
  type EnvironmentQuery,
  formatSecretDeclarationCollisionWarnings,
  getEnvironment,
  visibleCollisions,
} from "./http-shared.js";
import { creatorOf } from "./request-access.js";
import { nonEmptyText, objectSchema, urlText } from "./request-validation.js";

interface SecretQuery extends EnvironmentQuery {
  readonly overwrite?: string;
  readonly project?: string;
}

/**
 * Secrets belong to a project and an environment. `?project=` names the project by slug or id,
 * the default project when absent. Reading needs read in the environment, so a protected
 * environment's secrets take its grant. Creating needs edit there and gives the creator manage;
 * replacing or deleting an existing secret needs manage (packages/db/src/access.ts). A list
 * without `?project=` shows every project the caller may read there, with the caller's right on
 * each secret and its project by slug.
 */
export function registerSecretRoutes(
  app: ApiServer,
  options: { readonly platform: PlatformServices },
): void {
  const { platform } = options;
  const secretQuery = { schema: { querystring: objectSchema({ project: urlText }) } };
  app.get<{ Reply: SecretsResponse }>("/secrets", secretQuery, async (request) => {
    const environment = getEnvironment(request);
    const { project } = request.query as SecretQuery;
    let projectIds: readonly string[] | "all";
    if (project !== undefined) {
      projectIds = [(await credentialPlace(request)).projectId];
    } else {
      const scope = await request.access.scope(environment);
      projectIds = scope.all ? "all" : scope.projectIds;
    }
    const secrets = await platform.listSecrets(environment, projectIds);
    const rights = await request.access.credentialRights(
      secrets.map((secret) => ({ ...secret, kind: "secret" })),
    );
    return {
      environment,
      secrets: secrets.map((secret, index) => ({ ...secret, right: rights[index] ?? null })),
    };
  });

  const putSecret = {
    schema: {
      body: objectSchema({ value: nonEmptyText }, ["value"]),
      querystring: objectSchema({ overwrite: urlText, project: urlText }),
    },
  };
  app.put<{ Reply: SetSecretResponse }>("/secrets/:secretName", putSecret, async (request) => {
    const params = request.params as { secretName: string };
    const query = request.query as SecretQuery | undefined;
    const body = request.body as { value: string };
    const place = await credentialPlace(request);

    // PUT replaces an existing secret by default (HTTP PUT semantics). Callers that want the CLI's
    // atomic-create semantics pass `?overwrite=false`. The write names the secret whose right was
    // checked, or none for a create, and the DB layer holds it to that in the same transaction:
    // SECRET_ALREADY_EXISTS (409) when a create finds one, CREDENTIAL_CHANGED (409) when the
    // checked secret was replaced meanwhile.
    const overwrite = query?.overwrite !== "false";
    const existing = await platform.credentials.findCredential("secret", params.secretName, place);
    let replaces: string | null = null;
    if (existing === null) {
      await request.access.project(place.projectId, {
        action: "edit",
        environment: place.environment,
      });
    } else if (overwrite) {
      replaces = (await request.access.credential("secret", params.secretName, place, "manage")).id;
    }
    const secret = await platform.upsertSecret(params.secretName, body.value, place, {
      ...creatorOf(request),
      replaces,
    });
    const collisions = await platform.findSecretDeclarationCollisions({
      ...place,
      secretNames: [params.secretName],
    });

    return {
      ...secret,
      warnings: formatSecretDeclarationCollisionWarnings(
        await visibleCollisions(request, platform, place.environment, collisions),
      ),
    };
  });

  app.get<{ Reply: SecretResponse }>("/secrets/:secretName", secretQuery, async (request) => {
    const params = request.params as { secretName: string };
    const place = await credentialPlace(request);
    const secret = await platform.getSecret(params.secretName, place);
    if (secret === null) {
      throw new CodedError(
        "SECRET_NOT_FOUND",
        `Secret not found in environment ${place.environment}: ${params.secretName}`,
      );
    }

    return secret;
  });

  app.delete<{ Reply: NoContentResponse }>(
    "/secrets/:secretName",
    secretQuery,
    async (request, reply) => {
      const params = request.params as { secretName: string };
      const place = await credentialPlace(request);
      const checked = await request.access.credential("secret", params.secretName, place, "manage");
      if (!(await platform.deleteSecret(checked.id))) {
        throw new CodedError("SECRET_NOT_FOUND", `Secret not found: ${params.secretName}`);
      }

      reply.status(204);
      return null;
    },
  );
}

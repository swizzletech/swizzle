import type { InstanceRole, ProjectRole } from "./access.js";
import { sameSubject } from "./access.js";
import type { ProjectAccess, StoredServiceAccount } from "./access-store.js";
import type { ApiTokenStore, StoredApiToken } from "./api-token-types.js";
import { type ProjectRef, projectRef } from "./project-ref.js";

export interface TokenDirectory {
  project(id: string): Promise<ProjectRef | null>;
}
/** A token as the API shows it: its scope's projects by slug, and who minted it. */
export async function tokenView(names: TokenDirectory, token: StoredApiToken) {
  const projects =
    token.scope.projectIds === null
      ? null
      : await Promise.all(token.scope.projectIds.map((id) => names.project(id)));
  return {
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    id: token.id,
    issuedBy: token.issuedBy,
    lastUsedAt: token.lastUsedAt,
    name: token.name,
    revokedAt: token.revokedAt,
    scope: {
      environments: token.scope.environments,
      // A project deleted since the token was minted is left out; the token reaches nothing there.
      projects:
        projects === null
          ? null
          : projects.flatMap((project) => (project === null ? [] : [projectRef(project)])),
      role: token.scope.role,
    },
    tokenPrefix: token.tokenPrefix,
  };
}

export function tokenViews(names: TokenDirectory, tokens: readonly StoredApiToken[]) {
  return Promise.all(tokens.map((token) => tokenView(names, token)));
}

/** A service account with who created it, its grants in its project, and its tokens. */
export async function accountView(
  names: TokenDirectory,
  store: ApiTokenStore,
  account: StoredServiceAccount,
  access: ProjectAccess | null,
) {
  const subject = { kind: "service-account", serviceAccountId: account.id } as const;
  const tokens = await store.listTokens({
    kind: "service-account",
    serviceAccountId: account.id,
  });
  return {
    createdAt: account.createdAt,
    createdBy: account.createdBy,
    grants: (access?.grants ?? [])
      .filter((grant) => sameSubject(grant.subject, subject))
      .map(({ subject: _subject, via: _via, ...grant }) => grant),
    id: account.id,
    name: account.name,
    projectId: account.projectId,
    tokens: await tokenViews(names, tokens),
  };
}

export type TokenView = Awaited<ReturnType<typeof tokenView>>;
export type ServiceAccountView = Awaited<ReturnType<typeof accountView>>;

/** What GET /auth/identity answers: who the request acts as, and its role in the target. */
export interface IdentityResponse {
  readonly kind: "person" | "service-account";
  readonly person: {
    readonly email: string;
    readonly id: string;
    readonly name: string;
    readonly role: InstanceRole;
  } | null;
  readonly serviceAccount: {
    readonly id: string;
    readonly name: string;
    readonly project: ProjectRef;
  } | null;
  readonly token: TokenView | null;
  readonly target: {
    readonly environment: string | null;
    readonly project: { readonly reference: string } & Partial<ProjectRef>;
    readonly role: ProjectRole | null;
  } | null;
}

export type CreateServiceAccountResult = ServiceAccountView & { readonly changed: boolean };

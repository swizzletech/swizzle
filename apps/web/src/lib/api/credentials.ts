// Secrets and connections, who may use them, and their shares with other projects.

import type {
  AuthorizeConnectionResponse,
  ConnectionsResponse,
  CredentialAccessResponse,
  CredentialRef,
  CredentialRight,
  CredentialShareResponse,
  CredentialSharesResponse,
  NoContentResponse,
  SecretsResponse,
  SetSecretResponse,
  SharedCredentialsResponse,
  SubjectRef,
  TestConnectionResponse,
} from "../api";
import { json, request } from "./request";

export function credentialsCalls(environment: string) {
  return {
    async authorizeConnection(
      connectionName: string,
      input: {
        readonly provider?: string;
        readonly clientId?: string;
        readonly clientSecret?: string;
        readonly providerConfig?: Record<string, unknown>;
        readonly reuseFrom?: string;
        readonly scopes?: readonly string[];
      },
      /** The project by id or slug; the default project when absent. */
      project?: string,
      targetEnvironment = environment,
    ) {
      return await request<AuthorizeConnectionResponse>(
        `/connections/${encodeURIComponent(connectionName)}/authorize?${credentialQuery(targetEnvironment, project)}`,
        {
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    },

    async deleteConnection(
      connectionName: string,
      project: string,
      targetEnvironment = environment,
    ) {
      await request<NoContentResponse>(
        `/connections/${encodeURIComponent(connectionName)}?${credentialQuery(targetEnvironment, project)}`,
        {
          method: "DELETE",
        },
      );
    },

    async deleteSecret(secretName: string, project: string, targetEnvironment = environment) {
      await request<NoContentResponse>(
        `/secrets/${encodeURIComponent(secretName)}?environment=${encodeURIComponent(targetEnvironment)}&project=${encodeURIComponent(project)}`,
        {
          method: "DELETE",
        },
      );
    },

    async listConnections(targetEnvironment = environment) {
      return await request<ConnectionsResponse>(
        `/connections?environment=${encodeURIComponent(targetEnvironment)}`,
      );
    },

    /** Who may use and manage a credential; for anyone with a right on it. */
    async getCredentialAccess(credential: CredentialRef) {
      return await request<CredentialAccessResponse>(
        `${credentialPath(credential)}/access?${credentialQuery(environment, credential.projectId)}`,
      );
    },

    /** Gives `subject` use or manage, replacing a right it held by grant. */
    async setCredentialGrant(
      credential: CredentialRef,
      subject: SubjectRef,
      right: CredentialRight,
    ) {
      await request<NoContentResponse>(
        `${credentialPath(credential)}/grants?${credentialQuery(environment, credential.projectId)}`,
        json("PUT", { ...subject, right }),
      );
    },

    async removeCredentialGrant(credential: CredentialRef, subject: SubjectRef) {
      const query = new URLSearchParams(credentialQuery(environment, credential.projectId));
      for (const [key, value] of Object.entries(subject)) query.set(key, value);
      await request<NoContentResponse>(`${credentialPath(credential)}/grants?${query.toString()}`, {
        method: "DELETE",
      });
    },

    /** Offers the credential to `project`; accepted at once when the caller administers it too. */
    async offerCredentialShare(credential: CredentialRef, project: string) {
      return await request<CredentialShareResponse>(
        `${credentialPath(credential)}/shares/${encodeURIComponent(project)}?${credentialQuery(environment, credential.projectId)}`,
        { method: "PUT" },
      );
    },

    async withdrawCredentialShare(credential: CredentialRef, project: string) {
      await request<NoContentResponse>(
        `${credentialPath(credential)}/shares/${encodeURIComponent(project)}?${credentialQuery(environment, credential.projectId)}`,
        { method: "DELETE" },
      );
    },

    /** The project's credentials in this environment that the caller manages, with their shares. */
    async listSharedCredentials(project: string) {
      return (
        await request<SharedCredentialsResponse>(
          `/projects/${encodeURIComponent(project)}/shared-credentials?${credentialQuery(environment, undefined)}`,
        )
      ).credentials;
    },

    /** The shares offered to a project, accepted or not; for its admins. */
    async listCredentialShares(project: string) {
      return (
        await request<CredentialSharesResponse>(
          `/projects/${encodeURIComponent(project)}/credential-shares`,
        )
      ).shares;
    },

    async acceptCredentialShare(project: string, shareId: string) {
      return await request<CredentialShareResponse>(
        `/projects/${encodeURIComponent(project)}/credential-shares/${encodeURIComponent(shareId)}`,
        { method: "PUT" },
      );
    },

    /** Declines an offer, or ends an accepted share, for the receiving project. */
    async declineCredentialShare(project: string, shareId: string) {
      await request<NoContentResponse>(
        `/projects/${encodeURIComponent(project)}/credential-shares/${encodeURIComponent(shareId)}`,
        { method: "DELETE" },
      );
    },

    async listSecrets(targetEnvironment = environment) {
      return await request<SecretsResponse>(
        `/secrets?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

    async testConnection(connectionName: string, project: string, targetEnvironment = environment) {
      return await request<TestConnectionResponse>(
        `/connections/${encodeURIComponent(connectionName)}/test?${credentialQuery(targetEnvironment, project)}`,
        {
          method: "POST",
        },
      );
    },

    async upsertSecret(
      secretName: string,
      value: string,
      options: {
        readonly environment?: string;
        readonly overwrite?: boolean;
        /** The project by id or slug; the default project when absent. */
        readonly project?: string;
      } = {},
    ) {
      const targetEnvironment = options.environment ?? environment;
      const project =
        options.project === undefined ? "" : `&project=${encodeURIComponent(options.project)}`;
      // Dashboard defaults to safe create-only semantics; caller opts in to
      // overwrite only after acknowledging via the Add-secret form. The server
      // does the existence check + write atomically inside a transaction, so
      // concurrent clients can't both slip past a client-side pre-check.
      const overwrite = options.overwrite === true ? "true" : "false";
      return await request<SetSecretResponse>(
        `/secrets/${encodeURIComponent(secretName)}?environment=${encodeURIComponent(targetEnvironment)}&overwrite=${overwrite}${project}`,
        {
          body: JSON.stringify({ value }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "PUT",
        },
      );
    },
  };
}

/** The query that places a secret or connection: its environment and, when named, its project. */
function credentialQuery(environment: string, project: string | undefined): string {
  const query = new URLSearchParams({ environment });
  if (project !== undefined) query.set("project", project);
  return query.toString();
}

function credentialPath(credential: CredentialRef): string {
  return `/credentials/${credential.kind}/${encodeURIComponent(credential.name)}`;
}

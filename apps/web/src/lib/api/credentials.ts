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

    async getCredentialAccess(credential: CredentialRef) {
      return await request<CredentialAccessResponse>(
        `${credentialPath(credential)}/access?${credentialQuery(environment, credential.projectId)}`,
      );
    },

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

    async listSharedCredentials(project: string) {
      return (
        await request<SharedCredentialsResponse>(
          `/projects/${encodeURIComponent(project)}/shared-credentials?${credentialQuery(environment, undefined)}`,
        )
      ).credentials;
    },

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
        readonly project?: string;
      } = {},
    ) {
      const targetEnvironment = options.environment ?? environment;
      const project =
        options.project === undefined ? "" : `&project=${encodeURIComponent(options.project)}`;
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

function credentialQuery(environment: string, project: string | undefined): string {
  const query = new URLSearchParams({ environment });
  if (project !== undefined) query.set("project", project);
  return query.toString();
}

function credentialPath(credential: CredentialRef): string {
  return `/credentials/${credential.kind}/${encodeURIComponent(credential.name)}`;
}

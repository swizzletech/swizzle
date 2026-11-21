import type {
  CreateTeamResponse,
  DeleteTeamResponse,
  DirectoryResponse,
  InstanceRole,
  InvitationsResponse,
  NoContentResponse,
  PeopleResponse,
  PersonResponse,
  ProjectRole,
  ResetLinkResponse,
  SentInvitationResponse,
  TeamMembershipResponse,
  TeamsResponse,
} from "../api";
import { json, request } from "./request";

export function peopleCalls(environment: string) {
  return {
    async directory() {
      return request<DirectoryResponse>(
        `/directory?environment=${encodeURIComponent(environment)}`,
      );
    },

    async listPeople() {
      return (await request<PeopleResponse>("/users")).users;
    },

    async listInvitations() {
      return (await request<InvitationsResponse>("/invitations")).invitations;
    },

    async invite(input: {
      readonly email: string;
      readonly projects: readonly { readonly project: string; readonly role: ProjectRole }[];
      readonly role: InstanceRole;
    }) {
      return await request<SentInvitationResponse>("/invitations", json("POST", input));
    },

    async revokeInvitation(invitationId: string) {
      await request<NoContentResponse>(`/invitations/${encodeURIComponent(invitationId)}`, {
        method: "DELETE",
      });
    },

    async setRole(userId: string, role: InstanceRole) {
      return await request<PersonResponse>(
        `/users/${encodeURIComponent(userId)}/role`,
        json("PUT", { role }),
      );
    },

    async setSuspended(userId: string, suspended: boolean) {
      return await request<PersonResponse>(`/users/${encodeURIComponent(userId)}/suspension`, {
        method: suspended ? "PUT" : "DELETE",
      });
    },

    async createResetLink(userId: string) {
      return await request<ResetLinkResponse>(`/users/${encodeURIComponent(userId)}/reset-link`, {
        method: "POST",
      });
    },

    async resetTwoFactor(userId: string) {
      await request<NoContentResponse>(`/users/${encodeURIComponent(userId)}/two-factor`, {
        method: "DELETE",
      });
    },

    async removePerson(userId: string) {
      await request<NoContentResponse>(`/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
    },

    async listTeams() {
      return (await request<TeamsResponse>("/teams")).teams;
    },

    async createTeam(name: string) {
      return await request<CreateTeamResponse>("/teams", json("POST", { name }));
    },

    async deleteTeam(teamId: string) {
      await request<DeleteTeamResponse>(`/teams/${encodeURIComponent(teamId)}`, {
        method: "DELETE",
      });
    },

    async setTeamMember(teamId: string, userId: string, member: boolean) {
      await request<TeamMembershipResponse>(
        `/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
        { method: member ? "PUT" : "DELETE" },
      );
    },
  };
}

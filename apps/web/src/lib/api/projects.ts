import type {
  CreateProjectResponse,
  DeleteProjectResponse,
  EnvironmentProtectionResponse,
  GrantPlaceRef,
  IdentityResponse,
  ProjectAccessResponse,
  ProjectContentsChoice,
  ProjectContentsResponse,
  ProjectRole,
  ProjectsResponse,
  RemoveGrantResponse,
  SetGrantResponse,
  SubjectRef,
} from "../api";
import { json, request } from "./request";

export function projectsCalls() {
  return {
    async listProjects() {
      return await request<ProjectsResponse>("/projects", undefined);
    },

    async createProject(input: { readonly name: string; readonly slug: string }) {
      return await request<CreateProjectResponse>("/projects", json("POST", input));
    },

    async getProjectContents(project: string) {
      return await request<ProjectContentsResponse>(
        `/projects/${encodeURIComponent(project)}/contents`,
      );
    },

    async deleteProject(project: string, contents: ProjectContentsChoice | null) {
      const query =
        contents === null
          ? ""
          : contents.kind === "move"
            ? `?contents=move&to=${encodeURIComponent(contents.to)}`
            : "?contents=delete";
      return await request<DeleteProjectResponse>(
        `/projects/${encodeURIComponent(project)}${query}`,
        { method: "DELETE" },
      );
    },

    async getProjectAccess(project: string) {
      return await request<ProjectAccessResponse>(
        `/projects/${encodeURIComponent(project)}/access`,
      );
    },

    async setGrant(project: string, subject: SubjectRef, place: GrantPlaceRef, role: ProjectRole) {
      await request<SetGrantResponse>(
        `/projects/${encodeURIComponent(project)}/grants`,
        json("PUT", { ...subject, ...placeFields(place), role }),
      );
    },

    async removeGrant(project: string, subject: SubjectRef, place: GrantPlaceRef) {
      const query = new URLSearchParams({ ...subject, ...placeFields(place) });
      await request<RemoveGrantResponse>(
        `/projects/${encodeURIComponent(project)}/grants?${query.toString()}`,
        {
          method: "DELETE",
        },
      );
    },

    async setProtected(project: string, environment: string, isProtected: boolean) {
      await request<EnvironmentProtectionResponse>(
        `/projects/${encodeURIComponent(project)}/environments/${encodeURIComponent(environment)}/protection`,
        { method: isProtected ? "PUT" : "DELETE" },
      );
    },

    async getIdentity(project: string, environment?: string) {
      const query = new URLSearchParams({ project });
      if (environment !== undefined) query.set("environment", environment);
      return await request<IdentityResponse>(`/auth/identity?${query.toString()}`);
    },
  };
}

function placeFields(place: GrantPlaceRef): Record<string, string> {
  if (place.on === "automation") return { automation: place.automation };
  if (place.on === "environment") return { environment: place.environment };
  return {};
}

import type { Project } from "../../src/lib/api";

import type { MockRoute } from "./route";
import type { MockState } from "./state";

export const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

export const DEFAULT_PROJECT: Project = {
  createdAt: "2026-01-05T09:00:00.000Z",
  id: PROJECT_ID,
  name: "Default",
  protectedEnvironments: ["production"],
  role: "admin",
  slug: "default",
};

export function requestedProject(search: URLSearchParams): string {
  const project = search.get("project") ?? "default";
  return project === "default" ? PROJECT_ID : project;
}

export function projects({ is, json }: MockRoute, state: MockState) {
  if (is("GET", /^\/projects$/u)) return json({ projects: state.projects });
  return undefined;
}

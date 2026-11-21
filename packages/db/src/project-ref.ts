import type { StoredProject } from "./access-store.js";

export type ProjectRef = Pick<StoredProject, "id" | "slug" | "name">;

export function projectRef(project: ProjectRef): ProjectRef {
  return { id: project.id, name: project.name, slug: project.slug };
}

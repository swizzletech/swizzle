import type { SecretMetadata } from "../../src/lib/api";
import { DEFAULT_PROJECT, requestedProject } from "./projects";
import type { MockRoute } from "./route";
import { ago } from "./route";
import type { MockState } from "./state";

export function secrets({ is, json, param, search }: MockRoute, state: MockState) {
  if (is("GET", /^\/secrets$/u)) return json({ environment: "staging", secrets: state.secrets });
  if (is("PUT", /^\/secrets\/[^/]+$/u)) {
    const name = param(/^\/secrets\/([^/]+)$/u);
    const projectId = requestedProject(search);
    const { slug, name: projectName } =
      state.projects.find((project) => project.id === projectId) ?? DEFAULT_PROJECT;
    const secret: SecretMetadata = {
      algorithm: "aes-256-gcm",
      createdAt: ago(0),
      environment: "staging",
      id: `secret-${projectId}-${name}`,
      keyVersion: "v1",
      name,
      project: { id: projectId, name: projectName, slug },
      projectId,
      right: "manage",
      secretVersion: 1,
      updatedAt: ago(0),
    };
    const same = (item: { readonly name: string; readonly projectId: string }) =>
      item.name === name && item.projectId === projectId;
    state.secrets = [...state.secrets.filter((item) => !same(item)), secret];
    state.overview = {
      ...state.overview,
      needsYou: state.overview.needsYou.map((item) =>
        item.kind === "missing-secret" && item.secretName === name && item.project.id === projectId
          ? { ...item, state: "unbound" }
          : item,
      ),
    };
    return json(secret);
  }
  return undefined;
}

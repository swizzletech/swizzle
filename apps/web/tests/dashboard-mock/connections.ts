import type { ListedConnection } from "../../src/lib/api";
import { DEFAULT_PROJECT, requestedProject } from "./projects";
import type { MockRoute } from "./route";
import { ago, MINUTE } from "./route";
import type { MockState } from "./state";

export function connections({ body, is, json, param, search }: MockRoute, state: MockState) {
  if (is("GET", /^\/connections$/u)) {
    return json({
      connections: state.connections,
      environment: "staging",
      redirectBaseUrl: "https://swizzle.example.com",
    });
  }
  if (is("POST", /^\/connections\/[^/]+\/authorize$/u)) {
    const name = param(/^\/connections\/([^/]+)\/authorize$/u);
    const projectId = requestedProject(search);
    const input = body as { readonly clientId?: string; readonly provider?: string };
    const connection: ListedConnection = {
      accessTokenExpiresAt: null,
      authorizationPending: true,
      clientId: input.clientId ?? "",
      createdAt: ago(0),
      environment: "staging",
      id: `connection-${projectId}-${name}`,
      lastErrorAt: null,
      lastErrorCode: null,
      lastRefreshedAt: null,
      name,
      project: state.projects.find((project) => project.id === projectId) ?? DEFAULT_PROJECT,
      provider: input.provider ?? "google",
      right: "manage",
      scopes: [],
      status: "pending",
      tokenVersion: 0,
      updatedAt: ago(0),
    };
    state.connections = [
      ...state.connections.filter((item) => !(item.name === name && item.project.id === projectId)),
      connection,
    ];
    return json({
      authorizationUrl: `https://accounts.example.com/consent?connection=${name}`,
      connection,
      expiresAt: ago(-10 * MINUTE),
      redirectUri: `https://swizzle.example.com/oauth/callback/${connection.provider}`,
    });
  }
  return undefined;
}

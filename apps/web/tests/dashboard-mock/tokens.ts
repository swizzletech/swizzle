import type { CreatedApiToken, ScopeInput, TokenResponse } from "../../src/lib/api";
import { PROJECT_ID } from "./projects";
import type { MockRoute } from "./route";
import { ago } from "./route";
import type { MockState } from "./state";

export function tokens({ apiError, body, is, json, param }: MockRoute, state: MockState) {
  if (is("GET", /^\/auth\/tokens$/u)) return json({ tokens: state.tokens });
  if (is("POST", /^\/auth\/tokens$/u)) {
    const input = body as {
      readonly expiresAt: string;
      readonly name: string;
      readonly scope?: ScopeInput;
    };
    const id = `token-${state.tokens.length + 1}`;
    const projects =
      input.scope?.projects?.map((slug) => ({ id: PROJECT_ID, name: "Default", slug })) ?? null;
    const token: TokenResponse = {
      createdAt: ago(0),
      expiresAt: input.expiresAt,
      id,
      issuedBy: null,
      lastUsedAt: null,
      name: input.name,
      revokedAt: null,
      scope: {
        environments: input.scope?.environments ?? null,
        projects,
        role: input.scope?.role ?? "admin",
      },
      tokenPrefix: "swz_",
    };
    state.tokens = [...state.tokens, token];
    return json({
      ...token,
      token: `swz_${id}_one-time-plaintext`,
    } satisfies CreatedApiToken);
  }
  if (is("DELETE", /^\/auth\/tokens\/([^/]+)$/u)) {
    const id = param(/^\/auth\/tokens\/([^/]+)$/u);
    state.tokens = state.tokens.map((token) =>
      token.id === id ? { ...token, revokedAt: ago(0) } : token,
    );
    const revoked = state.tokens.find((token) => token.id === id);
    if (revoked === undefined) return apiError("API_TOKEN_NOT_FOUND", 404, "No such token.");
    return json(revoked);
  }
  return undefined;
}

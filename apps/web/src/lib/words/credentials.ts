// Secrets and connections in words: why one blocks its automations, what a right on one allows, where
// a right comes from and how a share stands.

import type {
  AttentionItem,
  CredentialRight,
  CredentialRightSource,
  ListedCredentialShare,
  ProjectRole,
} from "../api";
import { ageInWords } from "./time";

type ConnectionState = Extract<AttentionItem, { readonly kind: "missing-connection" }>["status"];

/** Why a declared connection blocks its automations. */
export const CONNECTION_PROBLEM: Record<ConnectionState, string> = {
  error: "The account stopped working. Reconnect it.",
  missing: "No account by that name is connected. Connect one, then deploy again.",
  pending: "The sign-in at the provider has not finished.",
  revoked: "The provider revoked the account. Connect it again.",
  unbound:
    "It was deployed with an account that is gone. Deploy it again to use the one connected now.",
};

/** Why a declared secret does not reach the runs: a deploy binds secrets by id at publish. */
export const SECRET_PROBLEM: Record<
  Extract<AttentionItem, { readonly kind: "missing-secret" }>["state"],
  string
> = {
  missing: "Its runs cannot start until the secret is set and the automation is deployed again.",
  unbound:
    "It was deployed with a secret of that name that is gone. Deploy it again to use the one set now.",
};

/** "verify-vault", "verify-vault and verify-probe", "verify-vault and 2 more". */
export function namesInWords(names: readonly string[]): string {
  const [first, second] = names;
  if (first === undefined) return "";
  if (names.length === 1) return first;
  if (names.length === 2) return `${first} and ${second}`;
  return `${first} and ${names.length - 1} more`;
}

/** What a role at a place means for the project's credentials, as the share form warns. */
export function credentialConsequence(
  role: ProjectRole,
  place: "project" | "automation" | "environment",
): string {
  const where = {
    automation: " This share reaches this automation only, never the project's credential list.",
    environment:
      " In a protected environment the project role alone gives nothing; this grant is the most they may do there.",
    project: "",
  }[place];
  const what = {
    viewer: "A viewer uses no credential.",
    operator:
      "An operator runs deployed automations with the credentials bound when they were published, and binds none in new code.",
    editor:
      "An editor deploys code that uses each credential they hold use on. That code can send an injected value anywhere, so use is trust in its author. Values stay write-only.",
    admin: "An admin manages every credential of the project. Values stay write-only.",
  }[role];
  return what + where;
}

/** What each right on a credential lets its holder do; manage does everything use does. */
export const CREDENTIAL_RIGHT_IN_WORDS: Record<CredentialRight, string> = {
  use: "Binds it in code they deploy. That code can send the value anywhere, so use is trust in its author.",
  manage: "Also replaces, deletes, grants and shares it. Nobody reads the value.",
};

/**
 * "use, granted to them", "manage through the team Billing", "by instance role owner". A manage
 * grant whose holder may not edit the credential's environment acts as use, and says so.
 */
export function credentialSourceInWords(source: CredentialRightSource, holds: CredentialRight) {
  if (source.kind === "role") {
    return source.role === "project-admin"
      ? "as admin of its project"
      : `by instance role ${source.role}`;
  }
  const how = source.kind === "team" ? `through the team ${source.teamName}` : "granted directly";
  const capped =
    source.right === "manage" && holds === "use"
      ? ", which acts as use while they may not edit this environment"
      : "";
  return `${source.right} ${how}${capped}`;
}

/** "Offered to Finance; its admin has not accepted", "Shared with Finance since 3 d ago". */
export function credentialShareInWords(share: ListedCredentialShare, now: Date): string {
  return share.acceptedAt === null
    ? `Offered to ${share.project.name}; an admin there has not accepted yet`
    : `Shared with ${share.project.name}, accepted ${ageInWords(share.acceptedAt, now)}: its admins may bind it there`;
}

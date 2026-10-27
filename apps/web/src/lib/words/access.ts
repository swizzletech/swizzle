// Access in words: what each role allows, why a request was refused, grants and token scopes, and
// sign-in and account errors.

import type { AccessGrant, AccessRefusal, ApiErrorCode, ProjectRole, TokenScope } from "../api";

const SIGN_IN_PROBLEMS: Readonly<Partial<Record<ApiErrorCode, string>>> = {
  AUTH_ACCOUNT_SUSPENDED: "This account is suspended. Ask an owner or admin of this instance.",
  AUTH_CODE_CHALLENGE_EXPIRED: "The sign-in took too long. Enter your password again.",
  AUTH_CODE_INVALID: "That code is incorrect, expired or already used. Try the current one.",
  AUTH_CODE_REQUIRED: "Enter the code from your authenticator app or a recovery code.",
  AUTH_CURRENT_PASSWORD_INVALID: "The current password is incorrect.",
  AUTH_INVALID_CREDENTIALS: "Email or password is incorrect.",
  AUTH_INVITATION_INVALID:
    "This invitation is used, revoked or expired, or it is for another address. Ask for a new one.",
  AUTH_INVITATION_REQUIRED:
    "This instance is already set up. Ask an owner or admin for an invitation.",
  AUTH_PASSWORD_INVALID: "The password must have 15 to 128 characters.",
  AUTH_RATE_LIMITED: "Too many attempts. Wait a moment and try again.",
  AUTH_RESET_LINK_INVALID:
    "This reset link is used or expired. Ask for a new one on the sign-in page or from an owner or admin.",
  AUTH_SETUP_DONE: "This instance is already set up. Sign in instead.",
  AUTH_SETUP_TOKEN_INVALID:
    "The setup token is wrong. Copy SWIZZLE_SETUP_TOKEN from the server's .env.",
};

/** The sentence for a sign-in or account error code; null leaves the API's own message. */
export function signInProblemInWords(code: ApiErrorCode | undefined): string | null {
  return code === undefined ? null : (SIGN_IN_PROBLEMS[code] ?? null);
}

/** What each project role lets its holder do; each role does everything the one before does. */
export const ROLE_IN_WORDS: Record<ProjectRole, string> = {
  viewer: "Reads automations, their runs, logs and results.",
  operator: "Also starts what is deployed, and retries and cancels runs.",
  editor: "Also changes code, deploys, rolls back, changes triggers and creates credentials.",
  admin:
    "Also decides who may do what, protects environments and manages service accounts and every credential.",
};

/** A token scope as a refusal carries it: projects by id. */
interface RefusalScope {
  readonly role: ProjectRole;
  readonly projectIds: readonly string[] | null;
  readonly environments: readonly string[] | null;
}

/** A role given at one place, as a refusal lists where the person's role comes from. */
type RefusalSource = AccessRefusal["sources"][number];

/** A 403's details: a project refusal, a credential right, or an instance role. */
interface Refusal {
  readonly required: string;
  readonly role: string | null;
  /** Present only when the token's scope is what limits the caller. */
  readonly scope?: RefusalScope | null;
  readonly sources?: readonly RefusalSource[];
  readonly credential?: { readonly kind: string; readonly name: string };
  readonly right?: string | null;
}

/** "editor on the project through the team Office", "operator in production". */
function sourceInWords(source: RefusalSource): string {
  let where: string;
  switch (source.on) {
    case "environment":
      where = `in ${source.environment}`;
      break;
    case "automation":
      where = "on this automation";
      break;
    case "project":
      where = "on the project";
      break;
  }
  return `${source.role} ${where}${source.via === null ? "" : ` through the team ${source.via.teamName}`}`;
}

const HIDDEN: ReadonlySet<ApiErrorCode> = new Set([
  "AUTOMATION_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "RUN_NOT_FOUND",
]);

/**
 * The sentences for a request refused for a missing right, or null for any other failure: what
 * it needs, what the person holds and through which grant or token, and whom to ask. An unknown
 * and an invisible resource answer alike, so a 404 says both.
 */
export function accessProblemInWords(error: {
  readonly status: number;
  readonly code?: ApiErrorCode | undefined;
  readonly details?: unknown;
  readonly message: string;
}): string | null {
  if (error.status === 404 && error.code !== undefined && HIDDEN.has(error.code)) {
    return `${error.message.replace(/\.?$/u, ".")} Either it does not exist, or no grant gives you access to it. An admin of its project can share it with you.`;
  }
  if (error.status !== 403 || error.code !== "ACCESS_DENIED") return null;
  const refusal = error.details as Refusal | undefined;
  if (refusal === undefined) return error.message;
  const token = refusal.scope ? ` ${tokenLimitInWords(refusal.scope)}` : "";
  if (refusal.credential !== undefined) {
    const { kind, name } = refusal.credential;
    return `This needs ${refusal.required} on the ${kind} ${name}; you hold ${refusal.right ?? "no right"} on it.${token} Ask someone who manages it.`;
  }
  if (refusal.sources === undefined) {
    // An instance owner or admin is refused here only for a narrowed token; the API says what works.
    if (refusal.role === "owner" || refusal.role === "admin") return `${error.message}${token}`;
    return `Only an instance owner or admin may do this. You are ${refusal.role === null ? "not signed in" : `a ${refusal.role}`} of this instance.${token}`;
  }
  return `This needs ${refusal.required}. ${refusalReasonInWords(error.details as AccessRefusal)}`;
}

/**
 * "Pause and Move to folder need editor and Run now needs operator. Your role here is viewer, …":
 * the controls a page leaves out, grouped by the role each needs, and those by why the person
 * lacks it, which reads once.
 */
export function refusedControlsInWords(
  controls: readonly { readonly label: string; readonly refusal: AccessRefusal }[],
): string {
  const groups = new Map<string, Map<string, string[]>>();
  for (const { label, refusal } of controls) {
    const reason = refusalReasonInWords(refusal);
    const needs = groups.get(reason) ?? new Map<string, string[]>();
    needs.set(refusal.required, [...(needs.get(refusal.required) ?? []), label]);
    groups.set(reason, needs);
  }
  return [...groups]
    .map(([reason, needs]) => {
      const clauses = [...needs].map(
        ([required, labels]) =>
          `${andList(labels)} ${labels.length === 1 ? "needs" : "need"} ${required}`,
      );
      return `${andList(clauses)}. ${reason}`;
    })
    .join(" ");
}

/** "a", "a and b", "a, b and c". */
function andList(parts: readonly string[]): string {
  return parts.length === 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Why a project refusal holds, after what it needs: the role the person holds and from which
 * grants, what limits it, and whom to ask. A grant that gives nothing where it was asked, such as
 * a project role in a protected environment, says so instead of calling itself their role there.
 */
function refusalReasonInWords(refusal: AccessRefusal): string {
  const sources = refusal.sources.map(sourceInWords);
  const environment = refusal.protectedEnvironment;
  let held: string;
  if (refusal.role !== null) {
    held = `Your role here is ${refusal.role}${sources.length === 0 ? "" : `, from ${sources.join(", ")}`}.`;
  } else if (sources.length > 0) {
    const one = sources.length === 1;
    held = `Your ${one ? "role" : "roles"} ${sources.join(", ")} ${one ? "gives" : "give"} you nothing ${environment ? `in ${environment}` : "here"}.`;
  } else {
    held = "You have no role here.";
  }
  const capped = environment
    ? ` The ${environment} environment is protected, so only a ${environment} grant counts there.`
    : "";
  const token = refusal.scope ? ` ${tokenLimitInWords(refusal.scope)}` : "";
  const ask = environment
    ? ` Ask an admin of this project to grant you ${environment}, or an owner or admin of the instance to add you to a team that holds it.`
    : " Ask an admin of this project.";
  return `${held}${capped}${token}${ask}`;
}

/** "The token you use acts at most as operator, only in staging and in 1 project." */
function tokenLimitInWords(scope: RefusalScope): string {
  const limits = [`at most as ${scope.role}`];
  if (scope.environments !== null) limits.push(`only in ${scope.environments.join(", ")}`);
  if (scope.projectIds !== null) {
    limits.push(
      `in ${scope.projectIds.length} ${scope.projectIds.length === 1 ? "project" : "projects"}`,
    );
  }
  return `The token you use acts ${limits.join(", ")}.`;
}

/** "editor on the project", "operator on export", "editor in production", with its team. */
export function grantInWords(
  grant: AccessGrant,
  automationName: (automationId: string) => string,
  teamName: string | null,
): string {
  return `${grant.role} ${placeInWords(grant, automationName)}${teamName === null ? "" : ` through the team ${teamName}`}`;
}

function placeInWords(grant: AccessGrant, automationName: (automationId: string) => string) {
  switch (grant.on) {
    case "project":
      return "on the project";
    case "automation":
      return `on ${automationName(grant.automationId)}`;
    case "environment":
      return `in ${grant.environment}`;
  }
}

/** "All your rights", or "editor · Office · staging, production". */
export function scopeInWords(scope: TokenScope, holder: "person" | "service-account"): string {
  const everything =
    scope.role === "admin" && scope.projects === null && scope.environments === null;
  if (everything && holder === "person") return "All your rights";
  const parts = [`at most ${scope.role}`];
  if (scope.projects !== null) {
    // A token's projects can all be deleted after it was minted.
    parts.push(
      scope.projects.length === 0
        ? "no project left"
        : scope.projects.map((project) => project.name).join(", "),
    );
  }
  parts.push(scope.environments === null ? "every environment" : scope.environments.join(", "));
  return parts.join(" · ");
}

// The first match names it: Edge and Opera also say Chrome, Chrome also says Safari, Android also
// says Linux.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//u, "Edge"],
  [/\b(?:OPR|Opera)\//u, "Opera"],
  [/\b(?:Firefox|FxiOS)\//u, "Firefox"],
  [/\b(?:HeadlessChrome|Chrome|CriOS)\//u, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//u, "Safari"],
];
const DEVICES: readonly (readonly [RegExp, string])[] = [
  [/\biPhone\b/u, "iPhone"],
  [/\biPad\b/u, "iPad"],
  [/\bAndroid\b/u, "Android"],
  [/\bCrOS\b/u, "ChromeOS"],
  [/\bMacintosh\b/u, "Mac"],
  [/\bWindows\b/u, "Windows"],
  [/\bLinux\b/u, "Linux"],
];

/** "Chrome on Mac", "Safari on iPhone", "curl": the browser a session signed in from. */
export function sessionDeviceInWords(userAgent: string | null): string {
  const agent = userAgent?.trim() ?? "";
  if (agent === "") return "Unknown browser";
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const device = DEVICES.find(([pattern]) => pattern.test(agent))?.[1];
  // Every browser's agent starts with Mozilla/; anything else, such as a script, by its own name.
  if (browser === undefined && agent.startsWith("Mozilla/"))
    return device === undefined ? "Unknown browser" : `Browser on ${device}`;
  if (browser === undefined) return agent.split(/[\s/]/u)[0] ?? agent;
  return device === undefined ? browser : `${browser} on ${device}`;
}

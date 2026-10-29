/**
 * Who has an account on this instance and what it is (ADR 0014). A Better Auth plugin admits
 * sign-up for exactly two people: the first account, which owns the instance and may need
 * SWIZZLE_SETUP_TOKEN, and the recipient of a pending invitation, who presents the token from its
 * link. `createPeople` changes accounts afterwards: invitations, roles, suspension, removal and a
 * lost second factor. auth.ts puts both behind SwizzleAuth.
 *
 * | Route or write                | What this plugin does                                          |
 * |-------------------------------|----------------------------------------------------------------|
 * | /sign-up/email, before        | setup token and "no account yet", or a pending invitation for the body's email |
 * | user insert, same transaction | claims the first account or the invitation; sets the role     |
 * | session insert                | refuses a suspended account                                    |
 * | account insert, same transaction | adds the first account to the team Release                  |
 * | sign-up and sign-in, after    | grants what the person's accepted invitation promised, once    |
 * | /reset-password               | mails the link; afterwards revokes the agent tokens (auth.ts)    |
 *
 * An invitation carries the project grants it promises. They become grants once its recipient has
 * an account, after that account's transaction committed, through AccountEffects.grantProject.
 * Each grant leaves the invitation in the transaction that gives it, so a failure is repaired at
 * the next sign-in for the grants still owed, and a grant given once is never given again.
 *
 * Every change to a person first takes an advisory transaction lock, so account changes run
 * one after another, including when no owner row exists. Inside that transaction it reads the
 * actor and
 * the person as they are now, decides with mayManagePeople, and keeps the last active owner: two
 * owners demoting each other at once leave one, and an admin cannot change someone an owner just
 * promoted.
 */

import type { Mailer } from "@swizzle/core";
import type { AuthContext, BetterAuthPlugin, DBTransactionAdapter } from "better-auth";
import { getCurrentAdapter } from "better-auth";
import { type APIError, createAuthMiddleware } from "better-auth/api";
import {
  type InstanceRole,
  mayManagePeople,
  type PendingGrant,
  parseProjectRole,
  RELEASE_TEAM_ID,
} from "./access.js";
import type { AccessStore } from "./access-store.js";
import type { ApiTokenStore } from "./api-tokens.js";
import {
  bodyField,
  normalizeEmail,
  randomToken,
  refusal,
  sameSecret,
  sha256,
} from "./auth-guarantees.js";
import { causeCode, PG_ERROR } from "./client.js";
import { CodedError } from "./coded-error.js";
import type { InvitationRow, PeopleStore, UserRow } from "./people-store.js";

/** The header `/sign-up/email` reads SWIZZLE_SETUP_TOKEN from. */
export const SETUP_TOKEN_HEADER = "x-swizzle-setup-token";
/** The header `/sign-up/email` reads an invitation's token from. */
export const INVITATION_TOKEN_HEADER = "x-swizzle-invitation-token";

const RESET_LINK_LIFETIME_MS = 60 * 60 * 1000;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
// The first account's claim is a budget row that never refills: one attempt, for good.
const FIRST_ACCOUNT_CLAIM = sha256("setup:first-account");
const NEVER = new Date("9999-12-31T00:00:00Z");

export type { PendingGrant } from "./access.js";

/** A pending invitation, as the people who manage the instance see it. Its token is not stored. */
export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: InstanceRole;
  readonly grants: readonly PendingGrant[];
  /** The person who sent it; null once their account is gone. */
  readonly invitedBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * An invitation just made, with its complete link: the dashboard's `/invitation#<token>`.
 * Only a hash of the token is stored, so the token exists in this URL alone, and the inviter sees it once
 * to pass on. `mailed` says whether the link also went out by mail, which needs SWIZZLE_SMTP_URL.
 */
export interface SentInvitation {
  readonly invitation: Invitation;
  readonly url: string;
  readonly mailed: boolean;
}

/**
 * A link to the dashboard's `/reset-password#<token>` that sets a new password once, until
 * `expiresAt`. Better Auth stores only a hash of the token, so the token exists in this URL alone.
 */
export interface ResetLink {
  readonly url: string;
  readonly expiresAt: string;
}

/** What HostAuth.recoverOwner (auth.ts) did. */
export type OwnerRecovery =
  | {
      readonly kind: "recovered";
      readonly userId: string;
      readonly email: string;
      readonly link: ResetLink;
    }
  /** The addresses of the active owners, so the operator can pick one. */
  | { readonly kind: "not-an-owner"; readonly owners: readonly string[] };

/** What the stores outside Better Auth do when an account changes; main.ts wires them. */
export interface AccountEffects {
  /** Gives a person one grant an invitation promised. */
  grantProject(userId: string, grant: PendingGrant): Promise<void>;
  /** Revokes every agent token of the person, after their password was reset. */
  revokeTokens(userId: string): Promise<void>;
}

/** The effects over Swizzle's stores, as main.ts and the test server wire them. */
export function accountEffects(stores: {
  readonly accessStore: Pick<AccessStore, "getProject" | "setGrant">;
  readonly apiTokenStore: Pick<ApiTokenStore, "revokeAllTokens">;
}): AccountEffects {
  const { accessStore, apiTokenStore } = stores;
  return {
    async grantProject(userId, { projectId, role }) {
      // A project deleted since the invitation went out promises nothing.
      if ((await accessStore.getProject(projectId)) === null) return;
      await accessStore.setGrant({ kind: "user", userId }, { on: "project", projectId, role });
    },
    async revokeTokens(userId) {
      await apiTokenStore.revokeAllTokens(userId);
    },
  };
}

/** Account links share one dashboard origin, whether mailed or handed over manually. */
export interface AccountLinks {
  readonly origin: string;
  readonly mailer: Mailer | null;
}

export interface MembershipOptions {
  readonly setupToken: string | null;
  readonly effects: AccountEffects;
}

const SIGNS_IN = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export function swizzleMembership(options: MembershipOptions): BetterAuthPlugin {
  return {
    hooks: {
      after: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.newSession?.user.id;
            if (userId === undefined) return;
            // A failure leaves the person signed in without the projects; the next sign-in retries.
            await grantPromised(ctx.context.adapter, options.effects, userId).catch((error) =>
              ctx.context.logger.error("The invitation's project grants were not given.", error),
            );
          }),
          matcher: (ctx) => SIGNS_IN.has(ctx.path ?? ""),
        },
      ],
      before: [
        {
          handler: createAuthMiddleware(async (ctx) => {
            const token = ctx.headers?.get(INVITATION_TOKEN_HEADER);
            if (token) {
              const invitation = await pendingInvitation(ctx.context.adapter, token);
              if (invitation?.email !== normalizeEmail(bodyField(ctx, "email"))) {
                throw invitationInvalid();
              }
              return;
            }
            if ((await ctx.context.adapter.count({ model: "user" })) > 0) {
              throw refusal(
                "FORBIDDEN",
                "AUTH_INVITATION_REQUIRED",
                "Accounts on this instance are by invitation. Ask an owner or admin to invite you.",
              );
            }
            if (options.setupToken !== null) {
              const presented = ctx.headers?.get(SETUP_TOKEN_HEADER) ?? "";
              if (!sameSecret(presented, options.setupToken)) {
                throw refusal(
                  "FORBIDDEN",
                  "AUTH_SETUP_TOKEN_INVALID",
                  "The setup token is invalid. Use the one-time token configured on the Swizzle server.",
                );
              }
            }
          }),
          matcher: (ctx) => ctx.path === "/sign-up/email",
        },
      ],
    },
    id: "swizzle-membership",
    init: (context) => ({
      options: {
        databaseHooks: {
          session: {
            create: {
              before: async (session) => {
                const user = await context.internalAdapter.findUserById(session.userId);
                if ((user as UserRow | null)?.suspendedAt) {
                  throw refusal(
                    "FORBIDDEN",
                    "AUTH_ACCOUNT_SUSPENDED",
                    "This account is suspended. An owner or admin of the instance can reactivate it.",
                  );
                }
              },
            },
          },
          account: {
            create: {
              // Sign-up inserts the person's password account after the person, in the same
              // transaction, so the first owner is in Release exactly when setup succeeded.
              before: async (account, ctx) => {
                if (ctx?.headers?.get(INVITATION_TOKEN_HEADER)) return;
                const adapter = await getCurrentAdapter(context.adapter);
                await adapter.create({
                  data: { teamId: RELEASE_TEAM_ID, userId: account.userId },
                  model: "teamMember",
                });
              },
            },
          },
          user: {
            create: {
              // Runs inside the transaction that inserts the user, so a sign-up that fails later
              // releases its claim.
              before: async (user, ctx) => {
                const adapter = await getCurrentAdapter(context.adapter);
                const token = ctx?.headers?.get(INVITATION_TOKEN_HEADER);
                if (!token) {
                  await claimFirstAccount(adapter);
                  return { data: { ...user, role: "owner" } };
                }
                // The inviter may have passed the link on by hand, so it does not prove the mailbox.
                const invitation = await claimInvitation(adapter, token, user.email);
                return { data: { ...user, role: invitation.role } };
              },
            },
          },
        },
      },
    }),
    schema: {
      invitation: {
        fields: {
          acceptedAt: { required: false, type: "date" },
          createdAt: { required: true, type: "date" },
          email: { required: true, type: "string" },
          expiresAt: { required: true, type: "date" },
          grantedAt: { required: false, type: "date" },
          grants: { required: true, type: "json" },
          invitedBy: {
            references: { field: "id", model: "user" },
            required: false,
            type: "string",
          },
          revokedAt: { required: false, type: "date" },
          role: { required: true, type: "string" },
          tokenHash: { required: true, type: "string", unique: true },
          userId: { references: { field: "id", model: "user" }, required: false, type: "string" },
        },
      },
      // Swizzle's own team_members (schema.ts), declared so setup writes the first owner's
      // membership of Release in the sign-up transaction.
      teamMember: {
        fields: {
          teamId: { required: true, type: "string" },
          userId: { references: { field: "id", model: "user" }, required: true, type: "string" },
        },
      },
      // The instance role (access.ts) and suspension; only the claims above and `createPeople` set them.
      user: {
        fields: {
          role: { defaultValue: "member", input: false, required: false, type: "string" },
          suspendedAt: { input: false, required: false, type: "date" },
        },
      },
    },
  };
}

function invitationInvalid(): APIError {
  return refusal(
    "NOT_FOUND",
    "AUTH_INVITATION_INVALID",
    "This invitation is used, revoked, expired or for another address. Ask for a new one.",
  );
}

/**
 * Of two setups racing past the "no account yet" check, PostgreSQL's unique key holds the second
 * insert until the first commits, then refuses it.
 */
async function claimFirstAccount(adapter: DBTransactionAdapter): Promise<void> {
  try {
    await adapter.create({
      data: { attempts: 1, keyHash: FIRST_ACCOUNT_CLAIM, windowEndsAt: NEVER },
      model: "authBudget",
    });
  } catch (error) {
    if (causeCode(error) === PG_ERROR.uniqueViolation) {
      throw refusal("CONFLICT", "AUTH_SETUP_DONE", "This Swizzle instance is already set up.");
    }
    throw error;
  }
}

/** Marks the invitation accepted, or refuses when another sign-up took it first. */
async function claimInvitation(
  adapter: DBTransactionAdapter,
  token: string,
  email: string,
): Promise<Invitation> {
  const invitation = await pendingInvitation(adapter, token);
  if (invitation === null || invitation.email !== normalizeEmail(email)) throw invitationInvalid();
  const claimed = await adapter.update({
    model: "invitation",
    update: { acceptedAt: new Date() },
    where: [
      { field: "id", value: invitation.id },
      { field: "acceptedAt", value: null },
      { field: "revokedAt", value: null },
    ],
  });
  if (claimed === null) throw invitationInvalid();
  return invitation;
}

async function pendingInvitation(
  adapter: DBTransactionAdapter,
  token: string,
): Promise<Invitation | null> {
  const row = await adapter.findOne<InvitationRow>({
    model: "invitation",
    where: [{ field: "tokenHash", value: sha256(token) }],
  });
  return row === null || !isPending(row) ? null : invitationView(row);
}

function isPending(row: InvitationRow): boolean {
  return !row.acceptedAt && !row.revokedAt && row.expiresAt.getTime() > Date.now();
}

/** Gives the grants of the person's accepted invitation, unless they were given already. */
async function grantPromised(
  adapter: AuthContext["adapter"],
  effects: AccountEffects,
  userId: string,
): Promise<void> {
  const user = await adapter.findOne<UserRow>({
    model: "user",
    where: [{ field: "id", value: userId }],
  });
  if (user === null) return;
  const owed = await adapter.findMany<InvitationRow>({
    model: "invitation",
    where: [
      { field: "email", value: user.email },
      { field: "grantedAt", value: null },
      { field: "acceptedAt", operator: "ne", value: null },
    ],
  });
  for (const invitation of owed) {
    let owes = true;
    while (owes) owes = await giveNextGrant(adapter, effects, invitation.id, userId);
  }
}

/**
 * Gives the first grant the invitation still owes and drops it from the invitation in the same
 * transaction; false once nothing is owed. The first write holds the invitation's row lock while
 * the grant is given, so two sign-ins at once never give the same grant, and a failure rolls the
 * drop back for the next sign-in. Only a commit that fails after the grant was given leaves it
 * owed, to be given again.
 */
async function giveNextGrant(
  adapter: AuthContext["adapter"],
  effects: AccountEffects,
  invitationId: string,
  userId: string,
): Promise<boolean> {
  return await adapter.transaction(async (tx) => {
    const row = await tx.update<InvitationRow>({
      model: "invitation",
      update: { userId },
      where: [
        { field: "id", value: invitationId },
        { field: "grantedAt", value: null },
      ],
    });
    if (row === null) return false;
    const [next, ...rest] = pendingGrants(row.grants);
    if (next !== undefined) await effects.grantProject(userId, next);
    await tx.update({
      model: "invitation",
      update: { grants: rest, ...(rest.length === 0 ? { grantedAt: new Date() } : {}) },
      where: [{ field: "id", value: invitationId }],
    });
    return rest.length > 0;
  });
}

function invitationView(row: InvitationRow): Invitation {
  return {
    createdAt: row.createdAt.toISOString(),
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    grants: pendingGrants(row.grants),
    id: row.id,
    invitedBy: row.invitedBy ?? null,
    role: row.role,
  };
}

/** The stored grants; Better Auth hands a JSON column back as text or as the parsed value. */
function pendingGrants(stored: unknown): readonly PendingGrant[] {
  const value: unknown = typeof stored === "string" ? JSON.parse(stored) : stored;
  if (!Array.isArray(value)) return [];
  return value.flatMap((grant: { projectId?: unknown; role?: unknown }) => {
    const role = parseProjectRole(grant.role);
    return typeof grant.projectId === "string" ? [{ projectId: grant.projectId, role }] : [];
  });
}

/** The account changes of SwizzleAuth; see its interface in auth.ts for each contract. */
export interface People {
  invite(input: {
    readonly email: string;
    readonly role: InstanceRole;
    readonly grants: readonly PendingGrant[];
    readonly invitedBy: string;
  }): Promise<SentInvitation>;
  findInvitation(token: string): Promise<Invitation | null>;
  listInvitations(): Promise<readonly Invitation[]>;
  revokeInvitation(actorId: string, invitationId: string): Promise<boolean>;
  setRole(actorId: string, userId: string, role: InstanceRole): Promise<boolean>;
  setSuspended(actorId: string, userId: string, suspended: boolean): Promise<boolean>;
  removePerson(actorId: string, userId: string): Promise<boolean>;
  resetTwoFactor(actorId: string, userId: string): Promise<boolean>;
  createResetLink(actorId: string, userId: string): Promise<ResetLink | null>;
  recoverOwner(email: string): Promise<OwnerRecovery>;
}

export function createPeople(store: PeopleStore, links: AccountLinks | null): People {
  /** The transaction locks before reading either actor, target or the remaining owners. */
  const changePerson = async <T>(request: {
    readonly actorId: string;
    readonly userId: string;
    readonly gives?: InstanceRole;
    readonly endsOwnership: boolean;
    readonly change: (tx: PeopleStore, user: UserRow) => Promise<T>;
  }): Promise<T | null> =>
    await store.transaction(async (tx) => {
      const { actorId, userId } = request;
      const user = await tx.findUser(userId);
      if (user === null) return null;
      const roles = [user.role, ...(request.gives === undefined ? [] : [request.gives])];
      const role = await actorRole(tx, actorId);
      if (role === null || !mayManagePeople(role, ...roles)) throw ownersOnly();
      if (isActiveOwner(user) && request.endsOwnership) {
        const owners = await tx.listUsers();
        if (!owners.some((owner) => owner.id !== userId && isActiveOwner(owner)))
          throw new CodedError(
            "AUTH_LAST_OWNER",
            "This is the last active owner. Make another person owner first.",
          );
      }
      return await request.change(tx, user);
    });
  const linkActions: Pick<People, "invite" | "createResetLink" | "recoverOwner"> =
    links === null
      ? {
          invite: unavailableLink("An invitation"),
          createResetLink: unavailableLink("A reset link"),
          recoverOwner: unavailableLink("A reset link"),
        }
      : {
          async invite(input) {
            const { origin, mailer } = links;
            const inviter = await store.findUser(input.invitedBy);
            if (
              inviter === null ||
              inviter.suspendedAt !== null ||
              !mayManagePeople(inviter.role, input.role)
            )
              throw ownersOnly();
            const email = normalizeEmail(input.email);
            if ((await store.findUserByEmail(email)) !== null)
              throw new CodedError("AUTH_ACCOUNT_EXISTS", `${email} already has an account here.`);
            const token = `swzi_${randomToken()}`;
            const url = `${origin}/invitation#${token}`;
            const latest = Math.max(
              0,
              ...(await store.findInvitations({ email, pending: true })).map((row) =>
                row.createdAt.getTime(),
              ),
            );
            const now = new Date(Math.max(Date.now(), latest + 1));
            const row = await store.insertInvitation({
              createdAt: now,
              email,
              expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS),
              grants: input.grants.map(({ projectId, role }) => ({ projectId, role })),
              invitedBy: input.invitedBy,
              role: input.role,
              tokenHash: sha256(token),
            });
            if (mailer !== null) {
              try {
                await mailer.send(invitationMail(origin, row, url, inviter.name));
              } catch (error) {
                await store.deleteInvitations({ id: row.id });
                throw new CodedError(
                  "AUTH_MAIL_FAILED",
                  `The invitation mail to ${email} was not accepted: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            await store.transaction(async (tx) => {
              const [newest, ...older] = await tx.findInvitations({ email, pending: true });
              if (newest === undefined) return;
              for (const invitation of older)
                await tx.updateInvitation(invitation.id, { revokedAt: new Date() }, true);
            });
            return { invitation: invitationView(row), mailed: mailer !== null, url };
          },
          async createResetLink(actorId, userId) {
            const { origin } = links;
            if (actorId === userId)
              throw new CodedError(
                "ACCESS_DENIED",
                "Change your own password under Settings › Account; a reset link is for someone else.",
              );
            return await changePerson({
              actorId,
              userId,
              endsOwnership: false,
              change: async (tx) => await mintResetLink(tx, userId, origin),
            });
          },
          async recoverOwner(email) {
            return await store.transaction(async (tx) => {
              const owner = await tx.findUserByEmail(normalizeEmail(email));
              if (owner === null || !isActiveOwner(owner))
                return {
                  kind: "not-an-owner",
                  owners: (await tx.listUsers()).filter(isActiveOwner).map((row) => row.email),
                };
              await turnOffTwoFactor(tx, owner);
              await tx.deleteSessions(owner.id);
              return {
                email: owner.email,
                kind: "recovered",
                link: await mintResetLink(tx, owner.id, links.origin),
                userId: owner.id,
              };
            });
          },
        };
  return {
    ...linkActions,
    async findInvitation(token) {
      const [row] = await store.findInvitations({ tokenHash: sha256(token), pending: true });
      return row === undefined ? null : invitationView(row);
    },
    async listInvitations() {
      return (await store.findInvitations({ pending: true })).map(invitationView);
    },
    async revokeInvitation(actorId, invitationId) {
      return await store.transaction(async (tx) => {
        const [row] = await tx.findInvitations({ id: invitationId, pending: true });
        if (row === undefined) return false;
        const role = await actorRole(tx, actorId);
        if (role === null || !mayManagePeople(role, row.role)) throw ownersOnly();
        return (await tx.updateInvitation(row.id, { revokedAt: new Date() }, true)) !== null;
      });
    },
    async setRole(actorId, userId, role) {
      return (
        (await changePerson({
          actorId,
          userId,
          gives: role,
          endsOwnership: role !== "owner",
          change: async (tx) => {
            await tx.updateUser(userId, { role });
          },
        })) !== null
      );
    },
    async setSuspended(actorId, userId, suspended) {
      return (
        (await changePerson({
          actorId,
          userId,
          endsOwnership: suspended,
          change: async (tx, user) => {
            await tx.updateUser(userId, {
              suspendedAt: suspended ? (user.suspendedAt ?? new Date()) : null,
            });
            if (suspended) await tx.deleteSessions(userId);
          },
        })) !== null
      );
    },
    async removePerson(actorId, userId) {
      return (
        (await changePerson({
          actorId,
          userId,
          endsOwnership: true,
          change: async (tx, user) => {
            await tx.removeFactors(userId);
            await tx.deleteInvitations({ email: user.email });
            await tx.deleteUser(userId);
          },
        })) !== null
      );
    },
    async resetTwoFactor(actorId, userId) {
      return (
        (await changePerson({
          actorId,
          userId,
          endsOwnership: false,
          change: turnOffTwoFactor,
        })) === true
      );
    },
  };
}

/** Better Auth's hashed verification identifier for its current reset-password contract. */
async function mintResetLink(
  store: PeopleStore,
  userId: string,
  origin: string,
): Promise<ResetLink> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + RESET_LINK_LIFETIME_MS);
  const identifier = Buffer.from(sha256(`reset-password:${token}`), "hex").toString("base64url");
  await store.insertVerification({ expiresAt, identifier, value: userId });
  return { expiresAt: expiresAt.toISOString(), url: passwordResetUrl(origin, token) };
}

async function turnOffTwoFactor(store: PeopleStore, user: UserRow): Promise<boolean> {
  const removed = await store.removeFactors(user.id);
  if (removed === 0 && !user.twoFactorEnabled) return false;
  await store.updateUser(user.id, { twoFactorEnabled: false });
  await store.deleteSessions(user.id);
  return true;
}

async function actorRole(store: PeopleStore, actorId: string): Promise<InstanceRole | null> {
  const row = await store.findUser(actorId);
  return row === null || row.suspendedAt !== null ? null : row.role;
}

function ownersOnly(): CodedError {
  return new CodedError("ACCESS_DENIED", "Only an owner may change an owner or make one.");
}

function isActiveOwner(user: UserRow): boolean {
  return user.role === "owner" && !user.suspendedAt;
}

function invitationMail(
  dashboardOrigin: string,
  invitation: InvitationRow,
  url: string,
  inviterName: string | undefined,
) {
  const inviter = inviterName ?? "Someone";
  const expires = invitation.expiresAt.toUTCString();
  return {
    subject: `${inviter} invited you to Swizzle`,
    text: [
      `${inviter} invited you to the Swizzle instance at ${dashboardOrigin} as ${invitation.role === "member" ? "a member" : `an ${invitation.role}`}.`,
      "",
      "Accept the invitation and choose your password here:",
      url,
      "",
      `The link works once, for this address only, until ${expires}.`,
      "If you did not expect this mail, ignore it.",
    ].join("\n"),
    to: invitation.email,
  };
}

/** The mail Better Auth asks for when a person forgot their password. */
export function passwordResetMail(origin: string, email: string, token: string) {
  return {
    subject: "Reset your Swizzle password",
    text: [
      `Someone asked to reset the password of ${email} on ${origin}.`,
      "",
      "Choose a new password here; the link works once, within an hour:",
      passwordResetUrl(origin, token),
      "",
      "A new password signs you out everywhere and revokes your agent tokens.",
      "Two-factor sign-in, if you use it, stays on. If you did not ask for this, ignore this mail.",
    ].join("\n"),
    to: email,
  };
}

function passwordResetUrl(origin: string, token: string): string {
  return `${origin}/reset-password#${token}`;
}

function unavailableLink(what: string): () => Promise<never> {
  return async () => {
    throw new CodedError(
      "DASHBOARD_ORIGIN_NOT_CONFIGURED",
      `${what} opens the dashboard. Set SWIZZLE_DASHBOARD_ORIGIN on the API to its http or https address.`,
    );
  };
}

/** The people and teams the runtime asks about: whom an approval names, who a notification reaches. */
import { eq, sql } from "drizzle-orm";

import { decide } from "./access.js";
import { createPostgresAccessStore } from "./access-tables.js";
import type { DatabaseClient } from "./client.js";
import type { ApprovalAssignee, AssigneeRequest } from "./run-approval.js";
import { authUsers, teams } from "./schema.js";

export async function resolveApprovalAssignee(
  client: DatabaseClient,
  request: AssigneeRequest,
): Promise<ApprovalAssignee | null> {
  if ("user" in request) {
    const [person] = await client.db
      .select({ email: authUsers.email, id: authUsers.id })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${request.user.trim().toLowerCase()}`);
    return person === undefined ? null : { kind: "user", label: person.email, userId: person.id };
  }
  const [team] = await client.db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(eq(teams.normalizedName, request.team.trim().toLowerCase()));
  return team === undefined ? null : { kind: "team", label: team.name, teamId: team.id };
}

export async function personMayRead(
  client: DatabaseClient,
  userId: string,
  target: {
    readonly automationId: string;
    readonly projectId: string;
    readonly environment: string;
  },
): Promise<boolean> {
  const [person] = await client.db
    .select({ role: authUsers.role, suspendedAt: authUsers.suspendedAt })
    .from(authUsers)
    .where(eq(authUsers.id, userId));
  if (person === undefined || person.suspendedAt !== null) return false;
  const grants = await createPostgresAccessStore({ client }).loadGrants({
    instanceRole: person.role,
    kind: "user",
    userId,
  });
  return decide(grants, { action: "read", environment: target.environment }, target).allowed;
}

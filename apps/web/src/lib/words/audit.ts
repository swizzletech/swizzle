// Audit events in words: what an event did and who did it.

import type { AuditEvent, AuditedRoute } from "../api";

// The contract lists every route the audit records, so a new one fails the type check here until
// it has words.
const ROUTE_WORDS: Readonly<Record<AuditedRoute, string>> = {
  "POST /approvals/:token": "Decided an approval through its link",
  "POST /events/:token": "Reported an event through its link",
  "POST /workers/enrollments": "Created a worker enrollment code",
  "DELETE /workers/:workerId": "Revoked a worker",
  "POST /auth/change-password": "Changed their password",
  "POST /auth/two-factor/enable": "Turned on two-factor sign-in",
  "POST /auth/two-factor/disable": "Turned off two-factor sign-in",
  "DELETE /auth/sessions/:sessionId": "Signed out a browser",
  "POST /auth/sessions/revoke-all": "Signed out every browser",
  "POST /auth/tokens": "Created an agent token",
  "DELETE /auth/tokens/:identifier": "Revoked an agent token",
  "POST /notifications/rules": "Added a notification rule",
  "PATCH /notifications/rules/:ruleId": "Changed a notification rule",
  "DELETE /notifications/rules/:ruleId": "Deleted a notification rule",
  "POST /security/audit": "Ran the security audit",
  "POST /environments": "Added an environment",
  "PUT /automations/:automationName/timeout-grant": "Set a timeout grant",
  "DELETE /automations/:automationName/timeout-grant": "Removed a timeout grant",
  "POST /projects": "Created a project",
  "POST /teams": "Created a team",
  "DELETE /teams/:team": "Deleted a team",
  "PUT /teams/:team/members/:person": "Added someone to a team",
  "DELETE /teams/:team/members/:person": "Removed someone from a team",
  "PUT /users/:userId/role": "Changed someone's role",
  "PUT /users/:userId/suspension": "Suspended someone",
  "DELETE /users/:userId/suspension": "Reactivated someone",
  "DELETE /users/:userId/two-factor": "Turned off someone's two-factor sign-in",
  "POST /users/:userId/reset-link": "Created a password reset link",
  "DELETE /users/:userId": "Removed someone",
  "POST /invitations": "Invited someone",
  "DELETE /invitations/:invitationId": "Withdrew an invitation",
  "POST /deployments": "Deployed",
  "DELETE /automations/:automationName": "Deleted an automation",
  "POST /automations/:automationName/rollback": "Rolled back",
  "POST /automations/:automationName/state": "Set a state value",
  "DELETE /automations/:automationName/state": "Deleted a state value",
  "POST /automations/:automationName/trigger/pause": "Paused the trigger",
  "POST /automations/:automationName/trigger/resume": "Resumed the trigger",
  "POST /automations/:automationName/runs": "Started a run",
  "PUT /automations/:automationName/folder": "Moved an automation to a folder",
  "PUT /automations/:automationName/project": "Moved an automation to another project",
  "POST /automation-folders": "Created a folder",
  "PATCH /automation-folders/:folderId": "Renamed a folder",
  "DELETE /automation-folders/:folderId": "Deleted a folder",
  "PUT /secrets/:secretName": "Set a secret",
  "DELETE /secrets/:secretName": "Deleted a secret",
  "POST /connections/:connectionName/authorize": "Started connecting an account",
  "POST /connections/:connectionName/test": "Tested a connected account",
  "DELETE /connections/:connectionName": "Deleted a connected account",
  "PUT /credentials/:kind/:name/grants": "Gave a right to a credential",
  "DELETE /credentials/:kind/:name/grants": "Took back a right to a credential",
  "PUT /credentials/:kind/:name/shares/:project": "Shared a credential with a project",
  "DELETE /credentials/:kind/:name/shares/:project": "Stopped sharing a credential",
  "PUT /projects/:project/credential-shares/:shareId": "Accepted a shared credential",
  "DELETE /projects/:project/credential-shares/:shareId": "Removed a shared credential",
  "POST /runs/:runId/replay": "Replayed a run",
  "POST /runs/:runId/cancel": "Cancelled a run",
  "POST /runs/:runId/events/:stepKey": "Sent an event to a run",
  "POST /runs/:runId/approvals/:stepKey": "Decided an approval",
  "PUT /runs/:runId/approvals/:stepKey/assignee": "Reassigned an approval",
  "DELETE /projects/:project": "Deleted a project",
  "PUT /projects/:project/grants": "Changed access",
  "DELETE /projects/:project/grants": "Removed access",
  "PUT /projects/:project/environments/:environment/protection": "Protected an environment",
  "DELETE /projects/:project/environments/:environment/protection": "Unprotected an environment",
  "POST /projects/:project/service-accounts": "Created a service account",
  "DELETE /projects/:project/service-accounts/:account": "Deleted a service account",
  "POST /projects/:project/service-accounts/:account/tokens": "Minted a service account token",
  "POST /projects/:project/service-accounts/:account/tokens/:identifier/rotation":
    "Rotated a service account token",
  "DELETE /projects/:project/service-accounts/:account/tokens/:identifier":
    "Revoked a service account token",
};

function isAuditedRoute(action: string): action is AuditedRoute {
  return Object.hasOwn(ROUTE_WORDS, action);
}

/**
 * What an audit event did. A request's route names it, a deployment adds its version, and an event
 * outside a request (a webhook delivery, a schedule, `just recover-owner`) is named by its change.
 */
export function auditActionInWords(
  event: Pick<AuditEvent, "action" | "status"> & Partial<Pick<AuditEvent, "change">>,
): string {
  const change = event.change ?? null;
  const done = doneInWords(event.action, change);
  if (event.status === null) return change === null ? `${done} (did not finish)` : done;
  if (event.status >= 500) return `${done}: failed`;
  if (event.status >= 400) return `${done}: refused, ${refusalInWords(event.status)}`;
  return done;
}

/** In order: a deployment's version, the route, the change outside a request, a host command. */
function doneInWords(action: string, change: AuditEvent["change"] | null): string {
  if (change?.kind === "deployment") return auditChangeInWords(change);
  if (isAuditedRoute(action)) return ROUTE_WORDS[action];
  if (change !== null) return auditChangeInWords(change);
  if (action === "recover-owner") return "Recovered an owner's access";
  return action;
}

function refusalInWords(status: number): string {
  if (status === 401 || status === 403) return "not allowed";
  if (status === 404) return "not found";
  if (status === 409) return "it had changed meanwhile";
  if (status === 429) return "too many requests";
  return "invalid request";
}

function auditChangeInWords(change: NonNullable<AuditEvent["change"]>): string {
  switch (change.kind) {
    case "deployment":
      return `${change.eventType === "rollback" ? "Rolled back to" : "Deployed"} ${change.version}`;
    case "worker":
      return {
        created: "Created worker",
        enrolled: "Enrolled worker",
        revoked: "Revoked worker",
        renewed: "Renewed worker credential",
        "scope-denied": "Refused worker scope",
      }[change.action];
    case "trigger":
      return {
        trigger_paused: "Paused trigger",
        trigger_resumed: "Resumed trigger",
        webhook_rejected: "Refused webhook",
        cron_missed: "Missed scheduled runs",
        cron_skipped: "Skipped scheduled run",
        chain_join_skipped: "Skipped joined run",
      }[change.eventType];
    case "timeout-grant":
      return change.eventType === "timeout_grant_set"
        ? "Set timeout grant"
        : "Removed timeout grant";
  }
}

/** The identity as it was when the change happened. */
export function auditActorInWords(actor: AuditEvent["actor"]): string {
  switch (actor.kind) {
    case "person":
    case "service-account":
    case "worker":
      return actor.label;
    case "system":
      return "System";
    case "host":
      return "Host shell";
    case "link":
      return "Link holder";
    case "anonymous":
      return "Anonymous caller";
  }
}

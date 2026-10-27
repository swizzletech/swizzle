import type { DeploymentChange, DeploymentCheckResponse } from "@swizzle/runtime/http-contract";

export function deploymentCheckOutput(check: DeploymentCheckResponse) {
  if (check.action === "create") return { action: check.action, changes: [] };
  return {
    action: check.action,
    changes: deploymentChangesOutput(check.action, check.changes, false),
  };
}

/**
 * What a dry run says changes. The API decides the action; an update with no source difference
 * redeploys because --force asked for it or because the credentials it binds changed.
 */
export function deploymentChangesOutput(
  action: "update" | "noop",
  changes: readonly DeploymentChange[],
  forced: boolean,
) {
  if (action === "noop") return "none: the source matches the active deployment";
  if (changes.length > 0) return changeRows(changes);
  return forced
    ? "none in the source: --force deploys it again"
    : "none in the source: the credentials it binds changed";
}

/** Values as text, so every change has the same three columns. */
export function changeRows(changes: readonly DeploymentChange[]) {
  return changes.map((change) => ({
    field: change.field,
    from: changeValue(change.from),
    to: changeValue(change.to),
  }));
}

/** A changed field's value as text: a string as itself, anything else as JSON. */
function changeValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  return typeof value === "string" ? value : JSON.stringify(value);
}

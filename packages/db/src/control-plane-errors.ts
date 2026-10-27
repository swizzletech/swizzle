/**
 * A write checked against one credential found another, or none, under its name by the time it
 * ran: the right was checked on a credential this write would not touch.
 */
import { CodedError } from "./coded-error.js";
export function credentialChanged(kind: "connection" | "secret", name: string): CodedError {
  const label = kind === "secret" ? "Secret" : "Connection";
  return new CodedError(
    "CREDENTIAL_CHANGED",
    `${label} ${name} was created, deleted or replaced in the meantime. Look at it again and retry.`,
    { details: { kind, name } },
  );
}

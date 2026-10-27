import type { InstanceRole } from "./access.js";

/** Who acted. A token id is the token a person or service account came with. */
export type AuditActor =
  | {
      readonly kind: "person";
      readonly userId: string;
      readonly label: string;
      readonly role: InstanceRole;
      readonly tokenId: string | null;
    }
  | {
      readonly kind: "service-account";
      readonly serviceAccountId: string;
      readonly label: string;
      readonly tokenId: string;
    }
  /** The holder of an approval or event link (ADR 0012). */
  | { readonly kind: "link" }
  /** Whoever called a public route without a credential, such as a webhook's sender. */
  | { readonly kind: "anonymous" }
  | { readonly kind: "worker"; readonly workerId: string; readonly label: string }
  /** Someone with a shell on the host, running a command in a service container. */
  | { readonly kind: "host" }
  | { readonly kind: "system" };

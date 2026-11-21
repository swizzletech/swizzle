import type { InstanceRole } from "./access.js";

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
  | { readonly kind: "link" }
  | { readonly kind: "anonymous" }
  | { readonly kind: "worker"; readonly workerId: string; readonly label: string }
  | { readonly kind: "host" }
  | { readonly kind: "system" };

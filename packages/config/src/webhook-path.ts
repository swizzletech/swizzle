/** Canonical path used by deployment registration and webhook ingress. */
export function normalizeWebhookPath(path: string | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    throw new Error("Webhook trigger paths must not be empty.");
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

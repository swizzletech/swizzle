/**
 * Connection names must map bijectively onto env var names
 * (`SWIZZLE_CONNECTION_<NAME>`), so they are strict lowercase kebab-case. The one definition: the
 * config schema, the runtime and the dashboard all import it. Browser-safe, like `intervals.ts`.
 */
export const AUTOMATION_CONNECTION_NAME_PATTERN = /^[a-z](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

import path from "node:path";
import { z } from "zod";
import { parseIntervalToMs } from "../intervals.js";
import { AUTOMATION_ENV_NAME_PATTERN } from "./names.js";

export const AUTOMATION_API_CHECK_MODES = ["active", "passive", "off"] as const;

export const AUTOMATION_API_CHECK_DEFAULTS = { every: "7d", untested_after: "30d" } as const;

const API_CHECK_MIN_INTERVAL_MS = 3_600_000;

const OFF_NEEDS_A_REASON = "mode off needs a reason, for example: paid per call.";

const apiCheckIntervalSchema = (fallback: string) =>
  z
    .string()
    .min(1)
    .default(fallback)
    .refine(
      (value) => {
        try {
          return parseIntervalToMs(value) >= API_CHECK_MIN_INTERVAL_MS;
        } catch {
          return false;
        }
      },
      { message: "Use an interval such as 12h, 7d or 30d, at least 1h." },
    );

export const apiCheckSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("active"),
    entrypoint: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The check script, relative to the automation folder, with the entrypoint's extension. Default `check` plus that extension, so `check.ts` beside `main.ts`.",
      ),
    every: apiCheckIntervalSchema(AUTOMATION_API_CHECK_DEFAULTS.every).describe(
      "How often the check runs, such as `12h` or `7d`, at least `1h`. Each deploy also runs it once.",
    ),
    secrets: z
      .array(z.string().regex(AUTOMATION_ENV_NAME_PATTERN))
      .optional()
      .describe(
        "The secrets the check receives, a subset of `secrets`, such as a read-only key. Default all of them.",
      ),
  }),
  z.strictObject({
    mode: z.literal("passive"),
    untested_after: apiCheckIntervalSchema(AUTOMATION_API_CHECK_DEFAULTS.untested_after).describe(
      "How long an API may go without a call before the Overview shows it as untested, at least `1h`. A cron trigger raises it to twice its interval.",
    ),
  }),
  z.strictObject({
    mode: z.literal("off"),
    reason: z
      .string({ error: OFF_NEEDS_A_REASON })
      .trim()
      .min(1, OFF_NEEDS_A_REASON)
      .describe("Why the API is not checked. The automation's About tab shows it."),
  }),
]);

/**
 * The first secret or connection through which an automation reaches an outside API, or null.
 * A webhook signing secret verifies calls that come in, so it does not count.
 */
export function findExternalApiDependency(config: {
  readonly connections: readonly string[];
  readonly secrets: readonly string[];
  readonly trigger: {
    readonly type: string;
    readonly signature?: { readonly secret: string } | undefined;
  };
}): { readonly kind: "connection" | "secret"; readonly name: string } | null {
  const signingSecret = config.trigger.type === "webhook" ? config.trigger.signature?.secret : null;
  const secret = config.secrets.find((name) => name !== signingSecret);
  if (secret !== undefined) return { kind: "secret", name: secret };
  const connection = config.connections[0];
  return connection === undefined ? null : { kind: "connection", name: connection };
}

/**
 * The secrets and connections a version binds when it deploys: those it lists, and a webhook's
 * signing secret, each once. `swizzle apply` binds them; `swizzle validate` checks their use.
 */
export function declaredCredentialNames(config: {
  readonly connections: readonly string[];
  readonly secrets: readonly string[];
  readonly trigger: {
    readonly type: string;
    readonly signature?: { readonly secret: string } | undefined;
  };
}): { readonly connections: readonly string[]; readonly secrets: readonly string[] } {
  const signing = config.trigger.type === "webhook" ? config.trigger.signature?.secret : undefined;
  return {
    connections: [...new Set(config.connections)],
    secrets: [...new Set([...config.secrets, ...(signing === undefined ? [] : [signing])])],
  };
}

/** An automation's `api_check` level, with the check entrypoint resolved. */
export type AutomationApiCheck =
  | {
      readonly mode: "active";
      readonly entrypoint: string;
      readonly every: string;
      readonly secrets?: readonly string[] | undefined;
    }
  | { readonly mode: "passive"; readonly untested_after: string }
  | { readonly mode: "off"; readonly reason: string };

/** `check.ts` beside `main.ts`: the check entrypoint an active `api_check` uses by default. */
export function defaultCheckEntrypoint(entrypoint: string): string {
  return path.posix.join(path.posix.dirname(entrypoint), `check${path.extname(entrypoint)}`);
}

export function normalizeApiCheck(
  apiCheck: z.output<typeof apiCheckSchema>,
  entrypoint: string,
): AutomationApiCheck {
  if (apiCheck.mode !== "active") return { ...apiCheck };
  return { ...apiCheck, entrypoint: apiCheck.entrypoint ?? defaultCheckEntrypoint(entrypoint) };
}

import { z } from "zod";

export const AUTOMATION_TRIGGER_TYPES = ["webhook", "cron", "chain"] as const;

const AUTOMATION_CHAIN_STATUSES = [
  "succeeded",
  "failed",
  "dead-lettered",
  "finished",
  "all-succeeded",
] as const;

const AUTOMATION_CHAIN_PAYLOAD_MODES = ["result", "payload", "full", "results"] as const;

export const AUTOMATION_WEBHOOK_SIGNATURE_ALGORITHMS = ["hmac-sha256"] as const;

export const AUTOMATION_WEBHOOK_SIGNATURE_ENCODINGS = ["hex", "base64"] as const;

// Webhook headers are forwarded to automations by default; only the channels the
// platform itself authenticates with are withheld. An allowlist would have to name
// every provider's signature header (Stripe, Slack, Close, whatever ships next) and
// would still leave the real invariant implicit — the security property lives
// entirely in denying these names, never in permitting the others. Keep this list
// minimal and credential-shaped: each entry must be a channel that carries an
// Swizzle credential, not merely a header that looks sensitive.
export const AUTOMATION_WEBHOOK_HEADER_DENYLIST = [
  // API bearer tokens (apps/api/src/auth-routes.ts) — forwarding this would hand
  // automation code the caller's platform credentials.
  "authorization",
  "proxy-authorization",
  // Dashboard session cookies.
  "cookie",
] as const;

// RFC 9110 field-name token, minus the characters no real header uses. Rejects
// whitespace, colons, and the other shapes that would silently never match.
const WEBHOOK_HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;

const jsonValueSchema = z.json();

const webhookPayloadSchemaSchema = z.record(z.string(), jsonValueSchema);

const webhookHeaderNameSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z
    .string()
    .min(1)
    .regex(
      WEBHOOK_HEADER_NAME_PATTERN,
      "Signature header must be a valid HTTP header name (letters, digits, and !#$%&'*+.^_`|~- ).",
    )
    .refine(
      (header) => !(AUTOMATION_WEBHOOK_HEADER_DENYLIST as readonly string[]).includes(header),
      {
        message: `Signature header must not be one of the platform's own credential headers: ${AUTOMATION_WEBHOOK_HEADER_DENYLIST.join(", ")}.`,
      },
    )
    .describe(
      `Any HTTP header name the sender uses, lower-cased, except the platform's own credential headers (${AUTOMATION_WEBHOOK_HEADER_DENYLIST.join(", ")}).`,
    ),
);

const webhookSignatureSchema = z.strictObject({
  algorithm: z
    .enum(AUTOMATION_WEBHOOK_SIGNATURE_ALGORITHMS)
    .default(AUTOMATION_WEBHOOK_SIGNATURE_ALGORITHMS[0])
    .describe("Signature algorithm over the raw request body."),
  encoding: z
    .enum(AUTOMATION_WEBHOOK_SIGNATURE_ENCODINGS)
    .default(AUTOMATION_WEBHOOK_SIGNATURE_ENCODINGS[0])
    .describe("Encoding of the digest in the header."),
  header: webhookHeaderNameSchema,
  prefix: z
    .string()
    .default("")
    .describe("Text stripped from the header value before the comparison, for example `sha256=`."),
  secret: z
    .string()
    .min(1)
    .describe(
      "Platform secret that holds the signing key. The run receives it only when `secrets` also lists it.",
    ),
});

export const webhookTriggerSchema = z.strictObject({
  type: z.literal("webhook"),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Ingress path, unique per environment. Local `swizzle run` works without it; deploy fails without it (`TRIGGER_CONFIGURATION_INVALID`), and a path another automation holds fails the deployment. The webhook answers at this exact path on the API. Use `/hooks/` for paths the public listener can receive.",
    ),
  payload_schema: webhookPayloadSchemaSchema
    .optional()
    .describe(
      "JSON Schema for the payload. `swizzle run` and webhook ingress reject a payload that does not match it (`WEBHOOK_PAYLOAD_INVALID`) before a run exists.",
    ),
  signature: webhookSignatureSchema
    .optional()
    .describe(
      "HMAC check over the raw request body, run before a run exists. Webhook ingress answers a missing or wrong signature with the opaque 404 `WEBHOOK_NOT_AVAILABLE` and records a `webhook_rejected` audit event.",
    ),
});

export const cronTriggerSchema = z
  .strictObject({
    type: z.literal("cron"),
    schedule: z
      .string()
      .min(1)
      .optional()
      .describe("Cron expression, evaluated in UTC. Set either `schedule` or `every`."),
    every: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Interval such as `30s`, `5m`, `2h30m` or `1d`, at least `30s`. Set either `schedule` or `every`.",
      ),
  })
  .refine((data) => data.schedule !== undefined || data.every !== undefined, {
    message:
      "Cron trigger requires either 'schedule' (cron expression) or 'every' (interval like 5m, 1h).",
  })
  .refine((data) => !(data.schedule !== undefined && data.every !== undefined), {
    message: "Cron trigger accepts 'schedule' or 'every', not both.",
  });

const SINGLE_SOURCE_CHAIN_STATUSES = [
  "succeeded",
  "failed",
  "dead-lettered",
  "finished",
] as const satisfies readonly (typeof AUTOMATION_CHAIN_STATUSES)[number][];

// Mirrors @swizzle/core's createDisplayName. packages/config stays
// dependency-light by contract, so the one-liner is replicated instead of imported.
export function normalizeAutomationName(name: string): string {
  return name.trim().replaceAll(/\s+/g, "-").toLowerCase();
}

const MULTI_SOURCE_CHAIN_STATUS =
  "all-succeeded" as const satisfies (typeof AUTOMATION_CHAIN_STATUSES)[number];

const SINGLE_SOURCE_CHAIN_PAYLOAD_MODES = [
  "result",
  "payload",
  "full",
] as const satisfies readonly (typeof AUTOMATION_CHAIN_PAYLOAD_MODES)[number][];

const MULTI_SOURCE_CHAIN_PAYLOAD_MODE =
  "results" as const satisfies (typeof AUTOMATION_CHAIN_PAYLOAD_MODES)[number];

export const chainTriggerSchema = z
  .strictObject({
    type: z.literal("chain"),
    source: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Upstream automation. Each of its runs that reaches `on` starts one run of this automation. Set either `source` or `sources`.",
      ),
    sources: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Two or more distinct upstream automations, not this one. The join fires once per origin run, after every source has a succeeded chain run for that origin. Manual, webhook and cron runs of a source do not count, and the join never fires when a source dead-letters.",
      ),
    on: z
      .enum(AUTOMATION_CHAIN_STATUSES)
      .default(SINGLE_SOURCE_CHAIN_STATUSES[0])
      .describe(
        "Upstream status that fires the trigger. With `source`: `succeeded`, `failed`, `dead-lettered` or `finished`. With `sources`: only `all-succeeded`, which is then the default.",
      ),
    payload: z
      .enum(AUTOMATION_CHAIN_PAYLOAD_MODES)
      .default(SINGLE_SOURCE_CHAIN_PAYLOAD_MODES[0])
      .describe(
        "Downstream payload. With `source`: `result` (the upstream result), `payload` (the upstream payload) or `full` (`{ source: { automationName, payload, result, runId, status } }`). With `sources`: only `results`, which is then the default: `{ origin: { automation, runId }, results: { <source>: <result> } }`.",
      ),
  })
  .superRefine((trigger, ctx) => {
    const hasSource = trigger.source !== undefined;
    const hasSources = trigger.sources !== undefined;

    if (hasSource === hasSources) {
      ctx.addIssue({
        code: "custom",
        message: "Chain trigger requires exactly one of 'source' or 'sources'.",
        path: hasSources ? ["sources"] : ["source"],
      });
      return;
    }

    if (hasSources) {
      const sources = trigger.sources ?? [];
      // Deployment resolves each source through the same slug normalization
      // (core's createDisplayName), so uniqueness must hold on normalized values —
      // otherwise "Review Bot" and "review-bot" pass here and collide at sync time.
      const uniqueSources = new Set(sources.map(normalizeAutomationName));
      if (sources.length < 2 || uniqueSources.size !== sources.length) {
        ctx.addIssue({
          code: "custom",
          message: "Chain trigger with 'sources' requires at least 2 distinct sources.",
          path: ["sources"],
        });
      }
      if (trigger.on !== MULTI_SOURCE_CHAIN_STATUS) {
        ctx.addIssue({
          code: "custom",
          message: "Chain trigger with 'sources' requires on: all-succeeded.",
          path: ["on"],
        });
      }
      if (trigger.payload !== MULTI_SOURCE_CHAIN_PAYLOAD_MODE) {
        ctx.addIssue({
          code: "custom",
          message: "Chain trigger with 'sources' requires payload: results.",
          path: ["payload"],
        });
      }
      return;
    }

    if (!(SINGLE_SOURCE_CHAIN_STATUSES as readonly string[]).includes(trigger.on)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Chain trigger with 'source' requires on: succeeded, failed, dead-lettered, or finished.",
        path: ["on"],
      });
    }
    if (!(SINGLE_SOURCE_CHAIN_PAYLOAD_MODES as readonly string[]).includes(trigger.payload)) {
      ctx.addIssue({
        code: "custom",
        message: "Chain trigger with 'source' requires payload: result, payload, or full.",
        path: ["payload"],
      });
    }
  });

// A join defaults `on` and `payload` to the only values it accepts; a single source keeps the schema defaults.
export function defaultChainJoinFields(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const trigger = value as Record<string, unknown>;
    if (trigger.type === "chain" && trigger.source === undefined && trigger.sources !== undefined) {
      return {
        ...trigger,
        on: trigger.on ?? MULTI_SOURCE_CHAIN_STATUS,
        payload: trigger.payload ?? MULTI_SOURCE_CHAIN_PAYLOAD_MODE,
      };
    }
  }

  return value;
}

export type AutomationJsonValue = z.infer<typeof jsonValueSchema>;

export type AutomationWebhookPayloadSchema = z.infer<typeof webhookPayloadSchemaSchema>;

export type AutomationWebhookSignatureConfig = z.infer<typeof webhookSignatureSchema>;

import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { z } from "zod";
import { AUTOMATION_CONNECTION_NAME_PATTERN } from "./connection-name.js";
import {
  type AutomationApiCheck,
  apiCheckSchema,
  findExternalApiDependency,
  normalizeApiCheck,
} from "./schema/api-check.js";
import { AUTOMATION_ENV_NAME_PATTERN, SWIZZLE_ENV_PREFIX } from "./schema/names.js";
import { assertWebhookPayloadSchemaIsValid } from "./schema/payload-validation.js";
import {
  AUTOMATION_RUNTIME_EXECUTION_MODES,
  AUTOMATION_RUNTIME_LANGUAGES,
  type AutomationRuntimeConfig,
  inferAutomationLanguage,
  runtimeConfigSchema,
} from "./schema/runtime.js";
import {
  AUTOMATION_TRIGGER_TYPES,
  AUTOMATION_WEBHOOK_HEADER_DENYLIST,
  AUTOMATION_WEBHOOK_SIGNATURE_ALGORITHMS,
  AUTOMATION_WEBHOOK_SIGNATURE_ENCODINGS,
  chainTriggerSchema,
  cronTriggerSchema,
  defaultChainJoinFields,
  normalizeAutomationName,
  webhookTriggerSchema,
} from "./schema/triggers.js";

// Pure interval helpers live in their own module so the dashboard can import
// them without pulling Node-only deps (`node:path`, `yaml`, `zod`) into the
// browser bundle. Re-exported here so existing `@swizzle/config` consumers
// keep working unchanged.
export { AUTOMATION_CONNECTION_NAME_PATTERN } from "./connection-name.js";

export { formatIntervalMs, parseIntervalToMs, parseQueueTimeoutToMs } from "./intervals.js";

// Mirror of @swizzle/connections CONNECTION_PROVIDER_IDS. Duplicated (not
// imported) to keep packages/config dependency-light; the drift is covered by a
// unit test that asserts the two lists match.
export const AUTOMATION_CONNECTION_PROVIDERS = [
  "google",
  "microsoft",
  "github",
  "clickup",
  "custom-oauth2",
] as const;

export const AUTOMATION_CONFIG_DECLARATIVE_FIELDS = [
  {
    path: "runtime.execution_mode=container",
    status: "enforced",
    enforcement:
      "Runs in a non-root, read-only container with dropped capabilities, process and resource limits, and an isolated runner network.",
  },
  {
    path: "runtime.permissions.network",
    status: "container_enforced",
    enforcement:
      "Enforced by container execution. Host/profile execution remains intended for trusted local development only.",
  },
  {
    path: "runtime.permissions.services",
    status: "container_enforced",
    enforcement:
      "The dispatcher requires the owner's worker service grant and healthy service. The sandbox receives an attempt token for bounded text inference through the named gateway.",
  },
  {
    path: "runtime.permissions.writable_dirs",
    status: "container_enforced",
    enforcement:
      "Enforced as bounded tmpfs mounts by container execution. Host/profile execution remains intended for trusted local development only.",
  },
  {
    path: "runtime.rate_limits",
    status: "worker_dequeue_only",
    enforcement:
      "Rate-limit groups are evaluated when a worker prepares execution. They are not public webhook ingress quotas.",
  },
] as const;

export const AUTOMATION_CONFIG_DEFAULTS = {
  connections: [] as string[],
  entrypoint: "main.py",
  runtime: runtimeConfigSchema.parse(undefined),
  secrets: [] as string[],
  vars: {} as Record<string, string | number | boolean>,
};

const triggerSchema = z.discriminatedUnion("type", [
  webhookTriggerSchema,
  cronTriggerSchema,
  chainTriggerSchema,
]);

const automationConfigRawSchema = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .describe(
        "Automation name. The platform keys deployments, runs and state on its slug (trimmed, whitespace to `-`, lower-cased), so keep it stable. It is unique across the whole instance: a name that an automation in another project holds, even one you cannot see, fails `swizzle validate`, `swizzle apply --dry-run` and `swizzle apply` with `AUTOMATION_PROJECT_MISMATCH`.",
      ),
    version: z
      .string()
      .min(1)
      .describe(
        "Author version. Metadata only: deployments are numbered by the platform as `#seq`.",
      ),
    description: z.string().min(1).optional().describe("One-line summary of the automation."),
    entrypoint: z
      .string()
      .min(1)
      .default(AUTOMATION_CONFIG_DEFAULTS.entrypoint)
      .describe("Script the run executes, relative to the automation folder."),
    trigger: z
      .preprocess(defaultChainJoinFields, triggerSchema)
      // The preprocess makes Zod treat the trigger as optional input, which it is not.
      .nonoptional()
      .describe("Exactly one trigger; `type` selects the variant."),
    runtime: runtimeConfigSchema.describe("Execution settings."),
    secrets: z
      .array(
        z
          .string()
          .regex(
            AUTOMATION_ENV_NAME_PATTERN,
            "Secret names must be uppercase env names matching ^[A-Z][A-Z0-9_]*$.",
          ),
      )
      .default(AUTOMATION_CONFIG_DEFAULTS.secrets)
      .describe(
        "Secret names the run receives as environment variables. Deployed runs read them from the encrypted store of their environment; local `swizzle run` reads them from the shell.",
      ),
    vars: z
      .record(
        z
          .string()
          .regex(
            AUTOMATION_ENV_NAME_PATTERN,
            "Var names must be uppercase env names matching ^[A-Z][A-Z0-9_]*$.",
          ),
        z.union([z.string(), z.number(), z.boolean()]),
      )
      .default(AUTOMATION_CONFIG_DEFAULTS.vars)
      .describe(
        "Plaintext settings versioned with the code, injected as environment variables and coerced to strings. A name may not start with `SWIZZLE_` or repeat a name in `secrets`.",
      ),
    connections: z
      .array(
        z
          .string()
          .regex(
            AUTOMATION_CONNECTION_NAME_PATTERN,
            "Connection names must be lowercase kebab-case (max 60 characters), e.g. google-main.",
          ),
      )
      .default(AUTOMATION_CONFIG_DEFAULTS.connections)
      .describe(
        "OAuth connections the run needs. Each arrives as `SWIZZLE_CONNECTION_<NAME>` (upper-cased, `-` as `_`) with `SWIZZLE_CONNECTION_<NAME>_EXPIRES_AT`. Local `swizzle run` does not resolve them, and deploy fails while one is missing or not active.",
      ),
    api_check: apiCheckSchema
      .optional()
      .describe(
        "How the platform notices that an outside API changed; `mode` selects the level. Required once the automation lists a connection or a secret other than `trigger.signature.secret`. `active` runs a read-only check script on its own schedule, never as a run; `passive` adds no calls and learns only from real runs; `off` needs a reason. Every level records the Deprecation and Sunset headers that SDK `apiFetch` sees.",
      ),
  })
  .superRefine((config, ctx) => {
    if (
      config.trigger.type === "chain" &&
      config.trigger.sources
        ?.map(normalizeAutomationName)
        .includes(normalizeAutomationName(config.name))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Chain trigger 'sources' must not include the automation itself.",
        path: ["trigger", "sources"],
      });
    }

    const secretNames = new Set(config.secrets);
    const dependency = findExternalApiDependency(config);
    if (config.api_check === undefined && dependency !== null) {
      ctx.addIssue({
        code: "custom",
        message: `uses ${dependency.kind} ${dependency.name}, so config.yaml must say how its API is checked. Add api_check with mode active (runs a read-only check script beside the entrypoint, such as check.ts, every 7d and after each deploy), mode passive (adds no calls, learns only from real runs) or mode off with a reason (for example: paid per call).`,
        path: ["api_check"],
      });
    }
    if (config.api_check?.mode === "active") {
      const checkEntrypoint = config.api_check.entrypoint;
      if (
        checkEntrypoint !== undefined &&
        path.extname(checkEntrypoint).toLowerCase() !==
          path.extname(config.entrypoint).toLowerCase()
      ) {
        ctx.addIssue({
          code: "custom",
          message: `The check runs in the entrypoint's language, so give it the extension of ${config.entrypoint}.`,
          path: ["api_check", "entrypoint"],
        });
      }
      for (const name of config.api_check.secrets ?? []) {
        if (!secretNames.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `Check secret "${name}" is not in secrets; the check receives a subset of the automation's secrets.`,
            path: ["api_check", "secrets"],
          });
        }
      }
    }
    for (const varName of Object.keys(config.vars)) {
      if (varName.startsWith(SWIZZLE_ENV_PREFIX)) {
        ctx.addIssue({
          code: "custom",
          message: `Var "${varName}" is reserved; names starting with ${SWIZZLE_ENV_PREFIX} are injected by the platform.`,
          path: ["vars", varName],
        });
      }
      if (secretNames.has(varName)) {
        ctx.addIssue({
          code: "custom",
          message: `Var "${varName}" conflicts with a declared secret of the same name. Use either vars or secrets, not both.`,
          path: ["vars", varName],
        });
      }
    }
  });

type AutomationConfigRaw = z.infer<typeof automationConfigRawSchema>;

/**
 * What an author writes in config.yaml: the schema's input, where a field with a default may be
 * omitted. The trigger's preprocess erases its input type, so it is named here.
 */
export type AutomationConfigInput = Omit<z.input<typeof automationConfigRawSchema>, "trigger"> & {
  readonly trigger: z.input<typeof triggerSchema>;
};

/** config.yaml for `config`, keys in the order given; `swizzle init` writes its scaffolds with it. */
export function stringifyAutomationConfig(config: AutomationConfigInput): string {
  return stringifyYaml(config);
}

export type AutomationVarValue = string | number | boolean;

/** Readonly fields and arrays derived from the schema output. */
type ReadonlyConfig<Value> = {
  readonly [Key in keyof Value]: Readonly<Value[Key]>;
};

/** The normalized document shared by parsed configs, deployments and run snapshots. */
export interface AutomationConfig
  extends Omit<ReadonlyConfig<AutomationConfigRaw>, "runtime" | "api_check" | "trigger"> {
  /** Absent only while the automation reaches no outside API, see `findExternalApiDependency`. */
  readonly api_check?: AutomationApiCheck | undefined;
  readonly runtime: AutomationRuntimeConfig;
  readonly trigger: ReadonlyConfig<AutomationConfigRaw["trigger"]>;
}

export const automationConfigSchema = automationConfigRawSchema;

export function createAutomationConfigJsonSchema(): Record<string, unknown> {
  return {
    // Input mode: a field with a default is optional for the author, not required.
    ...z.toJSONSchema(automationConfigRawSchema, { io: "input" }),
    title: "Swizzle automation config",
    description:
      "Machine-readable config contract for Swizzle automation folders. Generated from packages/config/src/schema.ts.",
    x_swizzle_declarative_fields: AUTOMATION_CONFIG_DECLARATIVE_FIELDS,
    x_swizzle_defaults: AUTOMATION_CONFIG_DEFAULTS,
    x_swizzle_inferred_runtime_fields: ["runtime.language"],
    x_swizzle_supported_connection_providers: AUTOMATION_CONNECTION_PROVIDERS,
    x_swizzle_supported_runtime_execution_modes: AUTOMATION_RUNTIME_EXECUTION_MODES,
    x_swizzle_supported_runtime_languages: AUTOMATION_RUNTIME_LANGUAGES,
    x_swizzle_supported_trigger_types: AUTOMATION_TRIGGER_TYPES,
    x_swizzle_webhook_header_denylist: AUTOMATION_WEBHOOK_HEADER_DENYLIST,
    x_swizzle_webhook_signature_algorithms: AUTOMATION_WEBHOOK_SIGNATURE_ALGORITHMS,
    x_swizzle_webhook_signature_encodings: AUTOMATION_WEBHOOK_SIGNATURE_ENCODINGS,
  };
}

export function normalizeAutomationConfig(config: AutomationConfigRaw): AutomationConfig {
  const triggerType = config.trigger.type;
  const onOverlapDefault = triggerType === "cron" ? "skip" : "queue";
  const { api_check: apiCheck, ...rest } = config;
  return {
    ...rest,
    ...(apiCheck === undefined
      ? {}
      : { api_check: normalizeApiCheck(apiCheck, config.entrypoint) }),
    runtime: {
      ...config.runtime,
      language: config.runtime.language ?? inferAutomationLanguage(config.entrypoint),
      on_overlap: config.runtime.on_overlap ?? onOverlapDefault,
      permissions: {
        ...config.runtime.permissions,
        writable_dirs: [...config.runtime.permissions.writable_dirs],
        services: [...config.runtime.permissions.services],
      },
      rate_limits: { ...config.runtime.rate_limits },
      requirements: {
        binaries: config.runtime.requirements.binaries.map((binary) => ({ ...binary })),
        ...(config.runtime.requirements.node !== undefined
          ? { node: { ...config.runtime.requirements.node } }
          : {}),
        ...(config.runtime.requirements.python !== undefined
          ? { python: { ...config.runtime.requirements.python } }
          : {}),
      },
      retry: { ...config.runtime.retry },
    },
    secrets: [...config.secrets],
    vars: { ...config.vars },
    connections: [...config.connections],
  };
}

export function parseAutomationConfig(input: string): AutomationConfig {
  const parsed = automationConfigRawSchema.safeParse(parseYaml(input));
  if (!parsed.success) {
    throw new Error(formatConfigIssues(parsed.error.issues));
  }
  const config = normalizeAutomationConfig(parsed.data);
  assertAutomationPayloadSchemasAreValid(config);
  return config;
}

/** One line per problem, each naming the config path: `trigger.shedule: unknown key`. */
function formatConfigIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .flatMap((issue): string[] => {
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${[...issue.path, key].join(".")}: unknown key`);
      }
      if (issue.code === "invalid_key") {
        // A rejected map key carries the reason (for example a var name pattern) one level down.
        return issue.issues.map(
          (inner) => `${[...issue.path, ...inner.path].join(".")}: ${inner.message}`,
        );
      }
      return [`${issue.path.join(".") || "config"}: ${issue.message}`];
    })
    .join("\n");
}

function assertAutomationPayloadSchemasAreValid(config: AutomationConfig): void {
  if (config.trigger.type !== "webhook" || config.trigger.payload_schema === undefined) {
    return;
  }

  assertWebhookPayloadSchemaIsValid(config.trigger.payload_schema);
}

export {
  AUTOMATION_API_CHECK_DEFAULTS,
  AUTOMATION_API_CHECK_MODES,
  type AutomationApiCheck,
  declaredCredentialNames,
  defaultCheckEntrypoint,
  findExternalApiDependency,
} from "./schema/api-check.js";

export { AUTOMATION_ENV_NAME_PATTERN, SWIZZLE_ENV_PREFIX } from "./schema/names.js";
export {
  assertWebhookPayloadSchemaIsValid,
  validateWebhookPayloadAgainstSchema,
  type WebhookPayloadValidationIssue,
  type WebhookPayloadValidationResult,
} from "./schema/payload-validation.js";
export {
  AUTOMATION_RETRY_DEFAULTS,
  AUTOMATION_RUNTIME_EXECUTION_MODES,
  AUTOMATION_RUNTIME_LANGUAGES,
  AUTOMATION_RUNTIME_PROFILE_DEFAULT,
  type AutomationBinaryRequirement,
  type AutomationNodeRequirements,
  type AutomationPythonRequirements,
  type AutomationRuntimeConfig,
  type AutomationRuntimePermissions,
  type AutomationRuntimeRequirements,
  inferAutomationLanguage,
} from "./schema/runtime.js";
export {
  AUTOMATION_TRIGGER_TYPES,
  AUTOMATION_WEBHOOK_HEADER_DENYLIST,
  AUTOMATION_WEBHOOK_SIGNATURE_ALGORITHMS,
  AUTOMATION_WEBHOOK_SIGNATURE_ENCODINGS,
  type AutomationJsonValue,
  type AutomationWebhookPayloadSchema,
  type AutomationWebhookSignatureConfig,
} from "./schema/triggers.js";

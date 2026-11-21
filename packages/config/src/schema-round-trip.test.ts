import fc from "fast-check";
import { expect, it } from "vitest";
import { runtimeConfigSchema } from "./schema/runtime.js";
import { chainTriggerSchema, webhookTriggerSchema } from "./schema/triggers.js";
import {
  type AutomationConfigInput,
  type AutomationWebhookPayloadSchema,
  automationConfigSchema,
  normalizeAutomationConfig,
  parseAutomationConfig,
  stringifyAutomationConfig,
} from "./schema.js";

const text = fc.string({ unit: "binary", maxLength: 48 });
const nonemptyText = fc.oneof(
  fc.string({ unit: "binary", minLength: 1, maxLength: 48 }),
  fc.constantFrom("null", "true", "1e3", "# comment", "a: b", "first\nsecond\n\n"),
);
const identifier = fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u);
const minutes = fc.integer({ min: 1, max: 59 }).map((count) => `${count}m`);
const hours = fc.integer({ min: 1, max: 168 }).map((count) => `${count}h`);
const positiveInt = fc.integer({ min: 1, max: 100 });

const webhookSignature = webhookTriggerSchema.shape.signature.unwrap().shape;
const webhook = fc.record(
  {
    type: fc.constant(webhookTriggerSchema.shape.type.value),
    path: identifier.map((name) => `/hooks/${name}`),
    payload_schema: fc.constantFrom<AutomationWebhookPayloadSchema>(
      { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      { anyOf: [{ type: "string" }, { type: "null" }] },
    ),
    signature: fc.record(
      {
        algorithm: fc.constantFrom(...webhookSignature.algorithm.unwrap().options),
        encoding: fc.constantFrom(...webhookSignature.encoding.unwrap().options),
        header: identifier.map((name) => ` X-${name} `),
        prefix: text,
        secret: fc.constant("WEBHOOK_KEY"),
      },
      { requiredKeys: ["header", "secret"] },
    ),
  },
  { requiredKeys: ["type"] },
);
const cron = fc.oneof(
  minutes.map((every) => ({ type: "cron" as const, every })),
  fc.integer({ min: 0, max: 59 }).map((minute) => ({
    type: "cron" as const,
    schedule: `${minute} * * * *`,
  })),
);
const chain = fc.oneof(
  fc.record(
    {
      type: fc.constant(chainTriggerSchema.shape.type.value),
      source: identifier.map((name) => `upstream-${name}`),
      on: fc.constantFrom("succeeded", "failed", "dead-lettered", "finished"),
      payload: fc.constantFrom("result", "payload", "full"),
    },
    { requiredKeys: ["type", "source"] },
  ),
  identifier.map((name) => ({
    type: "chain" as const,
    sources: [`first-${name}`, `second-${name}`],
  })),
);

const runtimeShape = runtimeConfigSchema.unwrap().shape;
const runtime = fc.record(
  {
    execution_mode: fc.constantFrom(...runtimeShape.execution_mode.unwrap().options),
    binary_version_matching: fc.constant(runtimeShape.binary_version_matching.unwrap().value),
    language: fc.constantFrom(...runtimeShape.language.unwrap().options),
    on_overlap: fc.constantFrom(...runtimeShape.on_overlap.unwrap().options),
    permissions: fc.record(
      {
        network: fc.boolean(),
        services: fc.subarray(
          runtimeShape.permissions.unwrap().shape.services.unwrap().element.options,
        ),
        writable_dirs: fc.array(identifier, { maxLength: 3 }),
      },
      { requiredKeys: [] },
    ),
    profile: identifier,
    queue_timeout: hours,
    timeout: positiveInt.map((seconds) => `${seconds}s`),
    retry: fc.record(
      {
        max_attempts: positiveInt,
        backoff: fc.constantFrom(...runtimeShape.retry.unwrap().shape.backoff.unwrap().options),
      },
      { requiredKeys: [] },
    ),
    rate_limits: fc.dictionary(
      identifier,
      positiveInt.map((count) => `${count}/min`),
      {
        maxKeys: 3,
      },
    ),
    requirements: fc.record(
      {
        binaries: fc.array(
          fc.record(
            {
              name: identifier,
              version: fc
                .tuple(fc.constantFrom("", ">=", "<=", ">", "<", "="), positiveInt)
                .map(([operator, major]) => `${operator}${major}.0`),
            },
            { requiredKeys: ["name"] },
          ),
          { maxLength: 3 },
        ),
        node: fc.record(
          { lockfile: fc.constant("package-lock.json"), package_json: fc.constant("package.json") },
          { requiredKeys: [] },
        ),
        python: fc.record({ requirements_file: fc.constant("deps.txt") }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    ),
    container: fc.record(
      {
        base_image: fc.constant("node:26"),
        cpus: fc.constantFrom("0.5", "1", "2"),
        memory_mb: positiveInt,
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

const apiCheck = fc.oneof(
  fc.record(
    {
      mode: fc.constant("active"),
      every: hours,
      secrets: fc.subarray(["API_TOKEN", "SERVICE_KEY"]),
    },
    { requiredKeys: ["mode"] },
  ),
  fc.record({ mode: fc.constant("passive"), untested_after: hours }, { requiredKeys: ["mode"] }),
  fc.record({ mode: fc.constant("off"), reason: identifier }),
);

const parsedAutomationConfigs = fc
  .record(
    {
      name: nonemptyText.map((name) => `automation-${name}`),
      version: nonemptyText,
      description: nonemptyText,
      entrypoint: fc.constantFrom("src/main.py", "src/main.js", "src/main.ts"),
      trigger: fc.oneof(webhook, cron, chain),
      runtime,
      vars: fc.dictionary(
        identifier.map((name) => `VAR_${name.toUpperCase()}`),
        fc.oneof(text, fc.double({ noDefaultInfinity: true, noNaN: true }), fc.boolean()),
        { maxKeys: 4 },
      ),
      api_check: apiCheck,
      secrets: fc.subarray(["API_TOKEN", "SERVICE_KEY"]),
      connections: fc.array(identifier, { maxLength: 3 }),
    },
    { requiredKeys: ["name", "version", "trigger"] },
  )
  .map(({ secrets, connections, ...input }) => {
    const checkSecrets = input.api_check?.mode === "active" ? input.api_check.secrets : undefined;
    const source = {
      ...input,
      ...(input.api_check === undefined
        ? {}
        : { connections, secrets: [...new Set([...(secrets ?? []), ...(checkSecrets ?? [])])] }),
    } satisfies AutomationConfigInput;
    return automationConfigSchema.parse(source);
  });

const propertyOptions = { seed: 310731, numRuns: 200 };

it("round trips normalized config through the deployment parser", () => {
  fc.assert(
    fc.property(parsedAutomationConfigs, (parsed) => {
      const config = normalizeAutomationConfig(parsed, "deployment");
      expect(parseAutomationConfig(stringifyAutomationConfig(config), "deployment")).toStrictEqual(
        config,
      );
    }),
    propertyOptions,
  );
});

it("accepts stored config as source for redeploy", () => {
  fc.assert(
    fc.property(parsedAutomationConfigs, (parsed) => {
      const config = normalizeAutomationConfig(parsed);
      expect(parseAutomationConfig(stringifyAutomationConfig(config))).toStrictEqual(config);
    }),
    propertyOptions,
  );
});

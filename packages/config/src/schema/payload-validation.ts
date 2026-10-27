import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { AutomationWebhookPayloadSchema } from "./triggers.js";

const addFormats = (addFormatsModule as unknown as { readonly default: (ajv: Ajv) => Ajv }).default;

export interface WebhookPayloadValidationIssue {
  readonly instancePath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Record<string, unknown>;
  readonly schemaPath: string;
}

export type WebhookPayloadValidationResult =
  | {
      readonly ok: true;
    }
  | {
      readonly errors: readonly WebhookPayloadValidationIssue[];
      readonly ok: false;
    };

const webhookPayloadValidatorCache = new Map<string, ValidateFunction<unknown>>();

export function assertWebhookPayloadSchemaIsValid(
  schema: AutomationWebhookPayloadSchema,
  pathLabel = "trigger.payload_schema",
): void {
  try {
    void getWebhookPayloadValidator(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${pathLabel} must be a valid JSON Schema: ${message}`);
  }
}

export function validateWebhookPayloadAgainstSchema(
  schema: AutomationWebhookPayloadSchema | undefined,
  payload: unknown,
): WebhookPayloadValidationResult {
  if (schema === undefined) {
    return { ok: true };
  }

  const validate = getWebhookPayloadValidator(schema);
  if (validate(payload)) {
    return { ok: true };
  }

  return {
    errors: formatAjvErrors(validate.errors ?? []),
    ok: false,
  };
}

function getWebhookPayloadValidator(
  schema: AutomationWebhookPayloadSchema,
): ValidateFunction<unknown> {
  const cacheKey = JSON.stringify(schema);
  const cached = webhookPayloadValidatorCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const validator = createPayloadSchemaAjv().compile<unknown>(schema);
  webhookPayloadValidatorCache.set(cacheKey, validator);
  return validator;
}

function createPayloadSchemaAjv() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateSchema: true,
  });
  addFormats(ajv);
  return ajv;
}

function formatAjvErrors(
  errors: readonly ErrorObject[] | null | undefined,
): readonly WebhookPayloadValidationIssue[] {
  return (errors ?? []).map((error) => ({
    instancePath: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "Payload does not match schema.",
    params: error.params as Record<string, unknown>,
    schemaPath: error.schemaPath,
  }));
}

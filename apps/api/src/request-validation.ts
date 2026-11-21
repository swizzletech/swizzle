import { AUTOMATION_CONNECTION_NAME_PATTERN, AUTOMATION_ENV_NAME_PATTERN } from "@swizzle/config";
import { ENVIRONMENT_NAME_PATTERN } from "@swizzle/db/postgres";
import { MAX_WAIT_LINK_TOKEN_LENGTH } from "@swizzle/runtime";

import type { ApiServer } from "./http-shared.js";

export const urlText = {
  maxLength: 512,
  minLength: 1,
  pattern: "^[^\\u0000-\\u001f\\u007f]+$",
  type: "string",
} as const;
export const uuid = { format: "uuid", type: "string" } as const;
export const text = { type: "string" } as const;
export const nonEmptyText = { minLength: 1, type: "string" } as const;
export const integer = { type: "integer" } as const;
export const boolean = { type: "boolean" } as const;
export const queryBoolean = { enum: ["false", "true"], type: "string" } as const;
export const queryInteger = { pattern: "^\\d+$", type: "string" } as const;
export const environmentName = {
  pattern: ENVIRONMENT_NAME_PATTERN.source,
  type: "string",
} as const;

const PATH_PARAMETERS: Readonly<Record<string, object>> = {
  account: urlText,
  automationName: urlText,
  connectionName: { pattern: AUTOMATION_CONNECTION_NAME_PATTERN.source, type: "string" },
  environment: environmentName,
  folderId: uuid,
  identifier: urlText,
  invitationId: uuid,
  kind: { enum: ["connection", "secret"], type: "string" },
  name: urlText,
  project: urlText,
  provider: urlText,
  ruleId: uuid,
  runId: uuid,
  secretName: { pattern: AUTOMATION_ENV_NAME_PATTERN.source, type: "string" },
  sessionId: uuid,
  shareId: uuid,
  stepKey: { ...urlText, maxLength: 255 },
  team: urlText,
  token: { ...urlText, maxLength: MAX_WAIT_LINK_TOKEN_LENGTH },
  userId: uuid,
  person: urlText,
  workerId: uuid,
};

export function objectSchema(
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
) {
  return { properties, required, type: "object" } as const;
}

export function registerRequestValidation(app: ApiServer): void {
  app.addHook("onRoute", (route) => {
    const names = [...route.url.matchAll(/:(\w+)/gu)].map((match) => match[1] as string);
    const params = names.map((name) => {
      const shape = PATH_PARAMETERS[name];
      if (shape === undefined) {
        throw new Error(
          `Route ${route.url} has parameter :${name}; declare its shape in PATH_PARAMETERS.`,
        );
      }
      return [name, shape] as const;
    });
    const query = route.schema?.querystring as
      | { properties?: Record<string, object>; required?: readonly string[] }
      | undefined;
    route.schema = {
      ...route.schema,
      ...(params.length > 0 ? { params: objectSchema(Object.fromEntries(params), names) } : {}),
      querystring: {
        ...query,
        ...objectSchema(
          { ...query?.properties, environment: environmentName },
          query?.required ?? [],
        ),
      },
    };
  });
}

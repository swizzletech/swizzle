import type { StoredEnvironment } from "@swizzle/db";
import { EnvironmentError, type EnvironmentStore } from "@swizzle/db/postgres";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type { EnvironmentResponse, EnvironmentsResponse } from "@swizzle/runtime/http-contract";

import type { ApiServer } from "./http-shared.js";
import { objectSchema, text } from "./request-validation.js";

export function registerEnvironmentRoutes(
  app: ApiServer,
  environmentStore: EnvironmentStore,
): void {
  const environmentBody = {
    schema: { body: objectSchema({ description: text, displayName: text, name: text }) },
  };
  app.get<{ Reply: EnvironmentsResponse }>("/environments", async () => {
    const defaultEnvironment = app.configuredEnvironment;
    return {
      defaultEnvironment,
      environments: withDefaultEnvironment(
        await environmentStore.listEnvironments(),
        defaultEnvironment,
      ),
    };
  });

  app.post<{ Reply: EnvironmentResponse }>(
    "/environments",
    environmentBody,
    async (request, reply) => {
      const body = request.body as
        | { readonly description?: string; readonly displayName?: string; readonly name?: string }
        | undefined;
      if (body?.name === undefined) {
        throw new AutomationRuntimeError(
          "AUTOMATION_CONFIG_INVALID",
          "Environment name is required.",
        );
      }

      try {
        const environment = await environmentStore.createEnvironment({
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
          name: body.name,
        });
        reply.status(201);
        return environment;
      } catch (error) {
        if (error instanceof EnvironmentError) {
          throw new AutomationRuntimeError("AUTOMATION_CONFIG_INVALID", error.message, {
            details: { code: error.code },
          });
        }
        throw error;
      }
    },
  );
}

function withDefaultEnvironment(
  environments: readonly StoredEnvironment[],
  defaultEnvironment: string,
): readonly StoredEnvironment[] {
  const existingDefault = environments.find(
    (environment) => environment.name === defaultEnvironment,
  );
  const defaultEntry =
    existingDefault ??
    ({
      createdAt: null,
      description: null,
      displayName: null,
      hasData: false,
      lastSeenAt: null,
      liveServices: [],
      name: defaultEnvironment,
      registered: false,
      updatedAt: null,
    } satisfies StoredEnvironment);

  return [
    defaultEntry,
    ...environments.filter((environment) => environment.name !== defaultEnvironment),
  ];
}

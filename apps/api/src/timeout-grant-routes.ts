import { CodedError } from "@swizzle/db";
import type {
  DeleteTimeoutGrantResponse,
  SetTimeoutGrantResponse,
  TimeoutGrantResponse,
  TimeoutGrantsResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";

import { type ApiServer, getEnvironment, requestValidationError } from "./http-shared.js";

/**
 * Operator-authenticated CRUD for per-automation run-timeout grants. A grant
 * raises the effective `runtime.timeout` ceiling for a single automation +
 * environment above the global `SWIZZLE_MAX_RUN_TIMEOUT`. Setting or reading a
 * grant for an unknown automation is a 404 (the facade resolves the automation
 * first).
 */
export function registerTimeoutGrantRoutes(app: ApiServer, platform: PlatformServices): void {
  app.get<{ Reply: TimeoutGrantsResponse }>("/timeout-grants", async (request) => {
    const environment = getEnvironment(request);
    return { environment, grants: await platform.listAutomationTimeoutGrants(environment) };
  });

  app.get<{ Reply: TimeoutGrantResponse }>(
    "/automations/:automationName/timeout-grant",
    async (request) => {
      const params = request.params as { automationName: string };
      const environment = getEnvironment(request);
      await request.access.automation(params.automationName, { action: "read", environment });
      const grant = await platform.getAutomationTimeoutGrant({
        automationName: params.automationName,
        environment,
      });
      return { automationName: params.automationName, environment, grant };
    },
  );

  app.put<{ Reply: SetTimeoutGrantResponse }>(
    "/automations/:automationName/timeout-grant",
    async (request) => {
      const params = request.params as { automationName: string };
      const body = request.body as { maxTimeoutMs?: unknown; note?: unknown } | undefined;

      if (
        typeof body?.maxTimeoutMs !== "number" ||
        !Number.isInteger(body.maxTimeoutMs) ||
        body.maxTimeoutMs <= 0
      ) {
        return requestValidationError(
          "maxTimeoutMs must be a positive integer number of milliseconds.",
        );
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
        return requestValidationError("note must be a string when provided.");
      }

      const environment = getEnvironment(request);
      const grant = await platform.setAutomationTimeoutGrant({
        automationName: params.automationName,
        environment,
        maxTimeoutMs: body.maxTimeoutMs,
        note: typeof body.note === "string" ? body.note : null,
      });
      return { automationName: params.automationName, environment, grant };
    },
  );

  app.delete<{ Reply: DeleteTimeoutGrantResponse }>(
    "/automations/:automationName/timeout-grant",
    async (request) => {
      const params = request.params as { automationName: string };
      const environment = getEnvironment(request);
      const deleted = await platform.deleteAutomationTimeoutGrant({
        automationName: params.automationName,
        environment,
      });

      if (!deleted) {
        throw new CodedError(
          "TIMEOUT_GRANT_NOT_FOUND",
          `No timeout grant to remove for automation in ${environment}: ${params.automationName}`,
        );
      }

      return { automationName: params.automationName, deleted: true, environment };
    },
  );
}

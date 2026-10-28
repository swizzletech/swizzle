import { AutomationRuntimeError } from "@swizzle/runtime";
import type {
  AutomationDeletePreviewResponse,
  AutomationDeploymentResponse,
  AutomationSecretsResponse,
  DeleteAutomationResponse,
  DeleteStateResponse,
  DeploymentAuditResponse,
  DeploymentResponse,
  DeploymentsResponse,
  MoveAutomationResponse,
  SetStateResponse,
  StateListResponse,
  StateValueResponse,
  TriggerAuditResponse,
  TriggerRunResponse,
  TriggerStatusResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";

import {
  type ApiServer,
  type EnvironmentQuery,
  getEnvironment,
  requestValidationError,
  serializeDeploymentResponse,
} from "./http-shared.js";
import { nonEmptyText, objectSchema, urlText, uuid } from "./request-validation.js";

export function registerAutomationRoutes(app: ApiServer, platform: PlatformServices): void {
  const stateKeyQuery = { schema: { querystring: objectSchema({ key: urlText }) } };
  app.get<{ Reply: AutomationDeploymentResponse }>(
    "/automations/:automationName",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      return await platform.getAutomationDeployment(params.automationName, getEnvironment(request));
    },
  );

  app.get<{ Reply: DeploymentsResponse }>(
    "/automations/:automationName/deployments",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const environment = getEnvironment(request);
      const deployments = await platform.listAutomationDeployments(
        params.automationName,
        environment,
      );

      return {
        automationName: params.automationName,
        deployments,
        environment,
      };
    },
  );

  app.get<{ Reply: DeploymentAuditResponse }>(
    "/automations/:automationName/deployments/audit",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      return await platform.listAutomationDeploymentAuditEvents(
        params.automationName,
        getEnvironment(request),
      );
    },
  );

  const rollbackBody = {
    schema: {
      body: objectSchema(
        // A deployment id or its number in the history, with or without `#`.
        { targetDeploymentId: { anyOf: [uuid, { pattern: "^#?\\d+$", type: "string" }] } },
        ["targetDeploymentId"],
      ),
    },
  };
  app.post<{ Reply: DeploymentResponse }>(
    "/automations/:automationName/rollback",
    rollbackBody,
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "edit",
        environment: getEnvironment(request),
      });
      const body = request.body as { targetDeploymentId: string };
      const environment = getEnvironment(request);

      const targetDeploymentId = await resolveDeploymentTarget(
        platform,
        params.automationName,
        environment,
        body.targetDeploymentId,
      );
      const deployment = await platform.rollbackDeployment({
        automationName: params.automationName,
        environment,
        targetDeploymentId,
      });

      return serializeDeploymentResponse(deployment);
    },
  );

  app.get<{ Reply: AutomationDeletePreviewResponse }>(
    "/automations/:automationName/delete-preview",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, { action: "delete" });
      const dependents = await platform.listAutomationChainDependents(params.automationName);
      const visible: AutomationDeletePreviewResponse["dependents"][number][] = [];
      for (const dependent of dependents) {
        if (
          (await request.access.refusal(dependent, {
            action: "read",
            environment: dependent.environment,
          })) === null
        ) {
          visible.push({
            automationSlug: dependent.automationSlug,
            environment: dependent.environment,
          });
        }
      }
      return { dependents: visible, hiddenDependents: dependents.length - visible.length };
    },
  );

  app.delete<{ Reply: DeleteAutomationResponse }>(
    "/automations/:automationName",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, { action: "delete" });
      return await platform.deleteAutomation({
        automationName: params.automationName,
        environment: getEnvironment(request),
      });
    },
  );

  // Moving changes who may touch the automation in both projects, so it needs both admins.
  const projectBody = { schema: { body: objectSchema({ project: nonEmptyText }, ["project"]) } };
  app.put<{ Reply: MoveAutomationResponse }>(
    "/automations/:automationName/project",
    projectBody,
    async (request) => {
      const params = request.params as { automationName: string };
      const body = request.body as { project: string };
      await request.access.automation(params.automationName, { action: "administer" });
      const target = await request.access.project(body.project, { action: "administer" });
      return await platform.moveAutomation(params.automationName, target.id);
    },
  );

  app.get<{ Reply: AutomationSecretsResponse }>(
    "/automations/:automationName/secrets",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const deployment = await platform.getAutomationDeployment(
        params.automationName,
        getEnvironment(request),
      );

      return {
        automationName: deployment.automationName,
        environment: deployment.environment,
        secrets: deployment.secretHealth,
      };
    },
  );

  app.get<{ Reply: StateListResponse | StateValueResponse }>(
    "/automations/:automationName/state",
    stateKeyQuery,
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const query = request.query as (EnvironmentQuery & { key?: string }) | undefined;
      const environment = getEnvironment(request);
      if (query?.key !== undefined) {
        const entry = await platform.getAutomationStateValue({
          automationName: params.automationName,
          environment,
          key: query.key,
        });
        return {
          automationName: params.automationName,
          environment,
          key: query.key,
          state: entry,
        };
      }

      return {
        automationName: params.automationName,
        environment,
        state: await platform.listAutomationState({
          automationName: params.automationName,
          environment,
        }),
      };
    },
  );

  const stateBody = { schema: { body: objectSchema({ key: nonEmptyText }, ["key"]) } };
  app.post<{ Reply: SetStateResponse }>(
    "/automations/:automationName/state",
    stateBody,
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "edit",
        environment: getEnvironment(request),
      });
      const body = request.body as { key: string; value?: unknown };
      if (!Object.hasOwn(body, "value")) {
        return requestValidationError("value is required.");
      }

      const environment = getEnvironment(request);
      return {
        automationName: params.automationName,
        environment,
        state: await platform.setAutomationStateValue({
          automationName: params.automationName,
          environment,
          key: body.key,
          value: body.value,
        }),
      };
    },
  );

  app.delete<{ Reply: DeleteStateResponse }>(
    "/automations/:automationName/state",
    stateKeyQuery,
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "edit",
        environment: getEnvironment(request),
      });
      const query = request.query as (EnvironmentQuery & { key?: string }) | undefined;
      if (typeof query?.key !== "string" || query.key.length === 0) {
        return requestValidationError("key is required.");
      }
      const environment = getEnvironment(request);
      return {
        automationName: params.automationName,
        deleted: await platform.deleteAutomationStateValue({
          automationName: params.automationName,
          environment,
          key: query.key,
        }),
        environment,
        key: query.key,
      };
    },
  );

  app.get<{ Reply: TriggerStatusResponse }>(
    "/automations/:automationName/trigger",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      return await platform.getAutomationTrigger(params.automationName, getEnvironment(request));
    },
  );

  app.get<{ Reply: TriggerAuditResponse }>(
    "/automations/:automationName/trigger/audit",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      return await platform.listAutomationTriggerAuditEvents(
        params.automationName,
        getEnvironment(request),
      );
    },
  );

  app.post<{ Reply: TriggerStatusResponse }>(
    "/automations/:automationName/trigger/pause",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "edit",
        environment: getEnvironment(request),
      });
      return await platform.pauseAutomationTrigger(params.automationName, getEnvironment(request));
    },
  );

  app.post<{ Reply: TriggerStatusResponse }>(
    "/automations/:automationName/trigger/resume",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "edit",
        environment: getEnvironment(request),
      });
      return await platform.resumeAutomationTrigger(params.automationName, getEnvironment(request));
    },
  );

  // A run started by hand reads as `manual`, so the caller's headers never pose as a sender's.
  app.post<{ Reply: TriggerRunResponse }>("/automations/:automationName/runs", async (request) => {
    const params = request.params as { automationName: string };
    await request.access.automation(params.automationName, {
      action: "run",
      environment: getEnvironment(request),
    });
    const run = await platform.startManualRun({
      automationName: params.automationName,
      correlationId: request.id,
      environment: getEnvironment(request),
      payload: request.body ?? {},
    });

    return {
      deploymentId: run.deploymentId,
      queuedAt: run.queuedAt,
      runId: run.runId,
      status: run.status,
      ...(run.warning !== undefined ? { warning: run.warning } : {}),
    };
  });
}

async function resolveDeploymentTarget(
  platform: PlatformServices,
  automationName: string,
  environment: string,
  target: string,
): Promise<string> {
  if (!/^#?\d+$/u.test(target)) return target;
  const seq = Number(target.replace(/^#/u, ""));
  const deployments = await platform.listAutomationDeployments(automationName, environment);
  const deployment = deployments.find((entry) => entry.seq === seq);
  if (!deployment) {
    throw new AutomationRuntimeError(
      "DEPLOYMENT_NOT_FOUND",
      `Deployment #${seq} not found for ${automationName}.`,
    );
  }
  return deployment.deploymentId;
}

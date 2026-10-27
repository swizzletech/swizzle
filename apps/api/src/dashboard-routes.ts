import {
  CodedError,
  type DashboardAutomationRefusals,
  type DashboardRunDetail,
  type DashboardRunListItem,
  getRunApproval,
  RUN_STATUSES,
  type RunTriggerType,
} from "@swizzle/db";
import type {
  AutomationDetailResponse,
  AutomationMermaidResponse,
  AutomationReadmeResponse,
  AutomationSourceResponse,
  AutomationsResponse,
  DashboardRunResponse,
  OverviewResponse,
  RunStepsResponse,
  RunsResponse,
  StepReachResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";

import type { DashboardDataProvider } from "./dashboard.js";
import {
  type ApiServer,
  type DashboardRunsQuery,
  getEnvironment,
  requestValidationError,
  withWebhookUrl,
} from "./http-shared.js";
import { objectSchema, queryBoolean, queryInteger, urlText, uuid } from "./request-validation.js";

/** `status=failed,dead-lettered` names the states a run list keeps. */
function parseRunStatuses(raw: string): DashboardRunListItem["status"][] {
  return raw.split(",").map((value) => {
    const status = RUN_STATUSES.find((known) => known === value.trim());
    if (status === undefined) {
      return requestValidationError(`Unknown run status: ${value}.`);
    }
    return status;
  });
}

export function registerDashboardRoutes(
  app: ApiServer,
  dashboard: DashboardDataProvider,
  platform: Pick<PlatformServices, "findAutomation">,
): void {
  app.get<{ Reply: OverviewResponse }>("/dashboard/overview", async (request) => {
    const environment = getEnvironment(request);
    const [overview, deploy] = await Promise.all([
      dashboard.getOverview(environment, await request.access.scope(environment), {
        mayDecide: async (run, approval) =>
          (await request.access.approvalRights(run, approval)).decide,
        mayEdit: async (automation) =>
          (await request.access.refusal(automation, { action: "edit", environment })) === null,
        operatesInstance: await request.access.operatesInstance(),
        subjects: await request.access.subjects(),
      }),
      request.access.placeRefusal(environment),
    ]);
    return { ...overview, deploy };
  });

  app.get<{ Reply: AutomationsResponse }>("/dashboard/automations", async (request) => {
    const environment = getEnvironment(request);

    return {
      automations: (
        await dashboard.listAutomations(environment, await request.access.scope(environment))
      ).map((automation) => withWebhookUrl(request, automation)),
      environment,
    };
  });

  app.get<{ Reply: AutomationDetailResponse }>(
    "/dashboard/automations/:automationName",
    async (request) => {
      const params = request.params as { automationName: string };
      const environment = getEnvironment(request);
      const owner = await request.access.automation(params.automationName, {
        action: "read",
        environment,
      });
      const automation = await dashboard.getAutomationDetail(
        params.automationName,
        environment,
        await request.access.scope(environment),
      );

      if (automation === null) {
        throw new CodedError(
          "ACTIVE_DEPLOYMENT_NOT_FOUND",
          `No active deployment found for automation: ${params.automationName}`,
        );
      }

      const [edit, organize, run] = await Promise.all([
        request.access.refusal(owner, { action: "edit", environment }),
        request.access.refusal(owner, { action: "organize" }),
        request.access.refusal(owner, { action: "run", environment }),
      ]);
      const refusals: DashboardAutomationRefusals = { edit, organize, run };
      return { ...withWebhookUrl(request, automation), refusals };
    },
  );

  app.get<{ Reply: AutomationReadmeResponse }>(
    "/dashboard/automations/:automationName/readme",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const readme = await dashboard.getAutomationReadme(
        params.automationName,
        getEnvironment(request),
      );

      if (readme === null) {
        throw new CodedError(
          "ACTIVE_DEPLOYMENT_NOT_FOUND",
          `No active deployment found for automation: ${params.automationName}`,
        );
      }

      return readme;
    },
  );

  const deploymentQuery = { schema: { querystring: objectSchema({ deployment: uuid }) } };
  app.get<{ Reply: AutomationMermaidResponse }>(
    "/dashboard/automations/:automationName/mermaid",
    deploymentQuery,
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const query = request.query as { deployment?: string } | undefined;
      const mermaid = await dashboard.getMermaidDiagram(
        params.automationName,
        getEnvironment(request),
        query?.deployment,
      );

      if (mermaid === null) {
        throw new CodedError(
          "DEPLOYMENT_NOT_FOUND",
          `No such deployment of automation: ${params.automationName}`,
        );
      }

      return mermaid;
    },
  );

  app.get<{ Reply: AutomationSourceResponse }>(
    "/dashboard/automations/:automationName/source",
    deploymentQuery,
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const query = request.query as { deployment?: string } | undefined;
      const source = await dashboard.getAutomationSource(
        params.automationName,
        getEnvironment(request),
        query?.deployment,
      );

      if (source === null) {
        throw new CodedError(
          "DEPLOYMENT_NOT_FOUND",
          `No such deployment of automation: ${params.automationName}`,
        );
      }

      return source;
    },
  );

  app.get<{ Reply: StepReachResponse }>(
    "/dashboard/automations/:automationName/step-reach",
    async (request) => {
      const params = request.params as { automationName: string };
      await request.access.automation(params.automationName, {
        action: "read",
        environment: getEnvironment(request),
      });
      const reach = await dashboard.getStepReach(params.automationName, getEnvironment(request));

      if (reach === null) {
        throw new CodedError(
          "ACTIVE_DEPLOYMENT_NOT_FOUND",
          `No active deployment found for automation: ${params.automationName}`,
        );
      }

      return reach;
    },
  );

  const runsQuery = {
    schema: {
      querystring: objectSchema({
        approvalOnly: queryBoolean,
        automation: urlText,
        limit: queryInteger,
        parentRunId: uuid,
        status: urlText,
        topLevelOnly: queryBoolean,
        triggerType: { enum: ["chain", "cron", "manual", "webhook"], type: "string" },
      }),
    },
  };
  app.get<{ Reply: RunsResponse }>("/dashboard/runs", runsQuery, async (request) => {
    const query = request.query as DashboardRunsQuery | undefined;
    const environment = getEnvironment(request);
    const approvalOnly = query?.approvalOnly === "true";
    // "Needs you" means the viewer: approvals for nobody in particular, them, or their teams.
    const subjects = approvalOnly ? await request.access.subjects() : null;
    return await dashboard.listRuns({
      ...(query?.approvalOnly !== undefined ? { approvalOnly } : {}),
      ...(subjects === null ? {} : { assignedTo: subjects }),
      ...(query?.automation !== undefined ? { automationSlug: query.automation } : {}),
      environment,
      ...(query?.limit !== undefined ? { limit: Number(query.limit) } : {}),
      ...(query?.parentRunId !== undefined ? { parentRunId: query.parentRunId } : {}),
      scope: await request.access.scope(environment),
      ...(query?.status !== undefined ? { statuses: parseRunStatuses(query.status) } : {}),
      ...(query?.topLevelOnly !== undefined ? { topLevelOnly: query.topLevelOnly === "true" } : {}),
      ...(query?.triggerType !== undefined
        ? { triggerType: query.triggerType as RunTriggerType }
        : {}),
    });
  });

  app.get<{ Reply: RunStepsResponse }>("/dashboard/runs/:runId/steps", async (request) => {
    const params = request.params as { runId: string };
    await request.access.run(params.runId, "read");
    return await dashboard.listRunSteps(params.runId);
  });

  app.get<{ Reply: DashboardRunResponse }>("/dashboard/runs/:runId", async (request) => {
    const params = request.params as { runId: string };
    const run = await request.access.run(params.runId, "read");
    const approval = getRunApproval(run);
    // A run stays in its project when its automation moves; Run again starts it where it is now,
    // and the agent it is handed to changes and deploys it there.
    const automation = (await platform.findAutomation(run.automationSlug)) ?? run;
    const need = { action: "run", environment: run.environment } as const;
    const [cancel, edit, runAgain] = await Promise.all([
      request.access.refusal(run, need),
      request.access.refusal(automation, { action: "edit", environment: run.environment }),
      request.access.refusal(automation, need),
    ]);
    return {
      ...run,
      refusals: { cancel, edit, runAgain },
      approval:
        approval === null
          ? null
          : { ...approval, may: await request.access.approvalRights(run, approval) },
    } satisfies DashboardRunDetail;
  });
}

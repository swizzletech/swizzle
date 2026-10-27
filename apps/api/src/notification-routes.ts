import { CodedError, DEFAULT_PROJECT_ID } from "@swizzle/db";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type {
  NoContentResponse,
  NotificationDeliveriesResponse,
  NotificationRuleResponse,
  NotificationRulesResponse,
} from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";

import {
  type ApiServer,
  getEnvironment,
  type NotificationDeliveriesQuery,
  type NotificationRuleBody,
  requestValidationError,
} from "./http-shared.js";
import {
  boolean,
  integer,
  objectSchema,
  queryInteger,
  text,
  urlText,
} from "./request-validation.js";

/**
 * A notification rule belongs to the person who made it and reaches only them, for one automation
 * or every automation of one project they may read. The worker checks that read access again
 * before each send (packages/runtime/src/notifications.ts), so revoked access ends the messages.
 */
export function registerNotificationRoutes(app: ApiServer, platform: PlatformServices): void {
  const ruleBody = {
    schema: {
      body: objectSchema({
        automationName: text,
        chatId: text,
        cooldownSeconds: integer,
        enabled: boolean,
        eventType: text,
        project: text,
        threshold: integer,
        windowSeconds: integer,
      }),
    },
  };
  const deliveriesQuery = {
    schema: {
      querystring: objectSchema({ automation: urlText, eventType: urlText, limit: queryInteger }),
    },
  };
  app.get<{ Reply: NotificationRulesResponse }>("/notifications/rules", async (request) => {
    const environment = getEnvironment(request);
    return {
      environment,
      rules: await platform.listNotificationRules(environment, personOf(request)),
    };
  });

  app.post<{ Reply: NotificationRuleResponse }>(
    "/notifications/rules",
    ruleBody,
    async (request) => {
      const userId = personOf(request);
      const body = request.body as NotificationRuleBody | undefined;
      if (!body?.chatId) {
        return requestValidationError("chatId is required.");
      }
      if (body.eventType !== "dead-lettered" && body.eventType !== "repeated-failures") {
        return requestValidationError("eventType must be dead-lettered or repeated-failures.");
      }
      if (body.automationName !== undefined && body.project !== undefined) {
        return requestValidationError("Name an automation or a project, not both.");
      }
      const environment = getEnvironment(request);
      const need = { action: "read", environment } as const;
      // Without an automation the rule covers every automation of the project, by default the
      // default project.
      const place =
        body.automationName !== undefined
          ? await request.access.automation(body.automationName, need)
          : {
              automationId: null,
              projectId: (await request.access.project(body.project ?? DEFAULT_PROJECT_ID, need))
                .id,
            };

      return await platform.createNotificationRule({
        automationId: place.automationId,
        chatId: body.chatId,
        ...(body.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        environment,
        eventType: body.eventType,
        projectId: place.projectId,
        ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
        userId,
        ...(body.windowSeconds !== undefined ? { windowSeconds: body.windowSeconds } : {}),
      });
    },
  );

  app.patch<{ Reply: NotificationRuleResponse }>(
    "/notifications/rules/:ruleId",
    ruleBody,
    async (request, reply) => {
      const params = request.params as { ruleId: string };
      const body = request.body as NotificationRuleBody | undefined;
      if (body?.automationName !== undefined || body?.project !== undefined) {
        return requestValidationError("A rule keeps its automation or project; make a new rule.");
      }
      const updatedRule =
        (await ownRule(request, params.ruleId)) &&
        (await platform.updateNotificationRule({
          ...(body?.chatId !== undefined ? { chatId: body.chatId } : {}),
          ...(body?.cooldownSeconds !== undefined ? { cooldownSeconds: body.cooldownSeconds } : {}),
          ...(body?.enabled !== undefined ? { enabled: body.enabled } : {}),
          ruleId: params.ruleId,
          ...(body?.threshold !== undefined ? { threshold: body.threshold } : {}),
          ...(body?.windowSeconds !== undefined ? { windowSeconds: body.windowSeconds } : {}),
        }));

      if (!updatedRule) {
        reply.status(404);
        throw new CodedError(
          "NOTIFICATION_RULE_NOT_FOUND",
          `Notification rule not found: ${params.ruleId}`,
        );
      }

      return updatedRule;
    },
  );

  app.delete<{ Reply: NoContentResponse }>(
    "/notifications/rules/:ruleId",
    async (request, reply) => {
      const params = request.params as { ruleId: string };
      const deleted =
        (await ownRule(request, params.ruleId)) &&
        (await platform.deleteNotificationRule(params.ruleId));

      if (!deleted) {
        reply.status(404);
        throw new CodedError(
          "NOTIFICATION_RULE_NOT_FOUND",
          `Notification rule not found: ${params.ruleId}`,
        );
      }

      reply.status(204);
      return null;
    },
  );

  /** Whether the rule exists and belongs to the person asking; another's rule reads as missing. */
  async function ownRule(request: FastifyRequest, ruleId: string): Promise<boolean> {
    const userId = personOf(request);
    const rule = await platform.getNotificationRule(ruleId);
    return rule !== null && rule.userId === userId;
  }

  // An instance owner or admin reads every delivery; anyone else the deliveries of their own rules
  // for automations they still read.
  app.get<{ Reply: NotificationDeliveriesResponse }>(
    "/notifications/deliveries",
    deliveriesQuery,
    async (request) => {
      const query = request.query as NotificationDeliveriesQuery | undefined;
      const environment = getEnvironment(request);
      const operator = await request.access.operatesInstance();

      return {
        deliveries: await platform.listNotificationDeliveries({
          ...(query?.automation ? { automationName: query.automation } : {}),
          environment,
          ...(query?.eventType === "dead-lettered" || query?.eventType === "repeated-failures"
            ? { eventType: query.eventType }
            : {}),
          ...(query?.limit !== undefined ? { limit: Number(query.limit) } : {}),
          ...(operator
            ? {}
            : {
                ruleOwner: {
                  scope: await request.access.scope(environment),
                  userId: personOf(request),
                },
              }),
        }),
        environment,
      };
    },
  );
}

/** The person a rule belongs to. A service account has none. */
function personOf(request: FastifyRequest): string {
  const actor = request.actor;
  if (actor?.kind === "person") return actor.userId;
  throw new AutomationRuntimeError(
    "ACCESS_DENIED",
    "A notification rule belongs to a person. Sign in, or use a personal token.",
  );
}

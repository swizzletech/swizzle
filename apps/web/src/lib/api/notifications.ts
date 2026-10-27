// Notification rules and the deliveries they sent.

import type {
  NoContentResponse,
  NotificationDeliveriesResponse,
  NotificationRule,
  NotificationRuleResponse,
  NotificationRulesResponse,
} from "../api";
import { request } from "./request";

export function notificationsCalls(environment: string) {
  return {
    /** Without an automation name the rule covers every automation in the environment. */
    async createNotificationRule(
      input: {
        readonly automationName?: string;
        readonly chatId: string;
        readonly cooldownSeconds?: number;
        readonly enabled?: boolean;
        readonly eventType: NotificationRule["eventType"];
        readonly threshold?: number;
        readonly windowSeconds?: number;
      },
      targetEnvironment = environment,
    ) {
      return await request<NotificationRuleResponse>(
        `/notifications/rules?environment=${encodeURIComponent(targetEnvironment)}`,
        {
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
    },

    async deleteNotificationRule(ruleId: string) {
      await request<NoContentResponse>(`/notifications/rules/${encodeURIComponent(ruleId)}`, {
        method: "DELETE",
      });
    },

    async listNotificationDeliveries(filters: {
      readonly automation?: string;
      readonly environment?: string;
      readonly eventType?: NotificationRule["eventType"];
      readonly limit?: number;
    }) {
      const query = new URLSearchParams();
      query.set("environment", filters.environment ?? environment);
      if (filters.automation) {
        query.set("automation", filters.automation);
      }
      if (filters.eventType) {
        query.set("eventType", filters.eventType);
      }
      if (filters.limit !== undefined) {
        query.set("limit", String(filters.limit));
      }

      return await request<NotificationDeliveriesResponse>(
        `/notifications/deliveries?${query.toString()}`,
      );
    },

    async listNotificationRules(targetEnvironment = environment) {
      return await request<NotificationRulesResponse>(
        `/notifications/rules?environment=${encodeURIComponent(targetEnvironment)}`,
        undefined,
      );
    },

    async updateNotificationRule(
      ruleId: string,
      input: {
        readonly chatId?: string;
        readonly cooldownSeconds?: number;
        readonly enabled?: boolean;
        readonly threshold?: number;
        readonly windowSeconds?: number;
      },
    ) {
      return await request<NotificationRuleResponse>(
        `/notifications/rules/${encodeURIComponent(ruleId)}`,
        {
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        },
      );
    },
  };
}

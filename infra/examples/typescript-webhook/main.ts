#!/usr/bin/env node
import { runAutomation } from "./swizzle-sdk.ts";

type PartnerPayload = {
  readonly customer?: {
    readonly email?: string;
    readonly id?: string;
  };
  readonly customer_id?: string;
  readonly email?: string;
  readonly event?: string;
  readonly occurred_at?: string;
  readonly source?: string;
  readonly type?: string;
  readonly vendor?: string;
  readonly [key: string]: unknown;
};

await runAutomation<PartnerPayload, Record<string, unknown>>(async ({ payload, logStep }) => {
  logStep("normalizing partner webhook", {
    source: payload.source ?? payload.vendor ?? "unknown",
  });

  return {
    status: "ok",
    normalized: {
      customer: {
        email: payload.customer?.email ?? payload.email ?? null,
        id: payload.customer?.id ?? payload.customer_id ?? null,
      },
      event: payload.event ?? payload.type ?? "unknown",
      meta: {
        received_fields: Object.keys(payload).sort(),
        schema_version: 1,
      },
      occurred_at: payload.occurred_at ?? new Date().toISOString(),
      payload,
      source: payload.source ?? payload.vendor ?? "unknown",
    },
  };
});

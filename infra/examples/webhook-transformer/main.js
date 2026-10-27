#!/usr/bin/env node
const chunks = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const raw = chunks.join("").trim();
  const payload = raw.length === 0 ? {} : JSON.parse(raw);

  const normalized = {
    event: payload.event ?? payload.type ?? "unknown",
    occurred_at: payload.occurred_at ?? new Date().toISOString(),
    source: payload.source ?? payload.vendor ?? "unknown",
    customer: {
      email: payload.customer?.email ?? payload.email ?? null,
      id: payload.customer?.id ?? payload.customer_id ?? null,
    },
    meta: {
      received_fields: Object.keys(payload).sort(),
      schema_version: 1,
    },
    payload,
  };

  process.stdout.write(JSON.stringify({ status: "ok", normalized }));
  process.stdout.write("\n");
});

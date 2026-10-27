/** Resource writers and reads share the instance audit's event contract. */
import { eq } from "drizzle-orm";
import type { AuditChange } from "./audit.js";
import { createPostgresAuditStore, recordAuditChange } from "./audit-tables.js";
import type { DatabaseClient } from "./client.js";
import type {
  CreateDeploymentAuditEventInput,
  CreateTriggerAuditEventInput,
} from "./control-plane-types.js";
import { automationNamed, automations } from "./schema.js";

type Db = DatabaseClient["db"];

async function automationAt(db: Db, id: string) {
  const [automation] = await db
    .select({
      projectId: automations.projectId,
      automationSlug: automations.slug,
      automationName: automations.name,
    })
    .from(automations)
    .where(eq(automations.id, id));
  if (automation === undefined) throw new Error(`Audit target automation not found: ${id}`);
  return automation;
}

export async function recordDeploymentChange(
  db: Db,
  input: CreateDeploymentAuditEventInput,
): Promise<void> {
  const { automationName: _name, ...automation } = await automationAt(db, input.automationId);
  const { occurredAt, ...change } = input;
  await recordAuditChange(db, {
    occurredAt,
    change: {
      ...change,
      ...automation,
      kind: "deployment",
      diff: input.diff ?? null,
      metadata: input.metadata ?? {},
      previousDeploymentId: input.previousDeploymentId ?? null,
      previousSourceHash: input.previousSourceHash ?? null,
      previousVersion: input.previousVersion ?? null,
    },
  });
}

export async function recordTriggerChange(
  db: Db,
  input: CreateTriggerAuditEventInput,
): Promise<void> {
  const automation = await automationAt(db, input.automationId);
  const { occurredAt, ...change } = input;
  await recordAuditChange(db, {
    occurredAt,
    change: {
      ...change,
      ...automation,
      kind: "trigger",
      metadata: input.metadata ?? {},
      runId: input.runId ?? null,
    },
  });
}

export async function recordTimeoutGrantChange(
  db: Db,
  input: Omit<
    Extract<AuditChange, { kind: "timeout-grant" }>,
    "kind" | "projectId" | "automationSlug"
  >,
): Promise<void> {
  const { automationName: _name, ...automation } = await automationAt(db, input.automationId);
  await recordAuditChange(db, {
    occurredAt: new Date().toISOString(),
    change: { ...input, ...automation, kind: "timeout-grant" },
  });
}

/** A moved automation's history remains in its original project. */
export async function listAutomationAudit(
  client: DatabaseClient,
  slug: string,
  environment: string,
  kind: AuditChange["kind"],
  limit: number,
  order: "newest" | "oldest" = "newest",
) {
  const [automation] = await client.db
    .select({ id: automations.id, projectId: automations.projectId })
    .from(automations)
    .where(automationNamed(slug));
  if (automation === undefined) return [];
  return await createPostgresAuditStore({ client }).list({
    automation: automation.id,
    environments: [environment],
    projectIds: [automation.projectId],
    kind,
    limit,
    order,
  });
}

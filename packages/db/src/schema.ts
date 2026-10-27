import type { WorkerService } from "@swizzle/config";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { CREDENTIAL_RIGHTS, INSTANCE_ROLES, type PendingGrant, PROJECT_ROLES } from "./access.js";

import type { ApiCheckReport } from "./check-report.js";
import { RUN_EXECUTION_PHASES } from "./control-plane-types/common.js";
import type {
  PlatformRunStatus,
  StoredBuildSnapshot,
  StoredConnectionUsage,
  StoredSecretUsage,
} from "./control-plane-types.js";
import type { ExecutionWait, RunStepResult, RunWait } from "./run-approval.js";

function inValues(
  column: SQL.Aliased | SQL | import("drizzle-orm/pg-core").PgColumn,
  values: readonly string[],
) {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  )})`;
}

/** A sorting folder inside one project; it grants nothing (ADR 0014). */
export const automationFolders = pgTable(
  "automation_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 80 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationFoldersNameUnique: uniqueIndex("automation_folders_name_unique").on(
      table.projectId,
      table.normalizedName,
    ),
    automationFoldersSortIdx: index("automation_folders_sort_idx").on(
      table.projectId,
      table.sortOrder,
      table.name,
    ),
  }),
);

// Access (ADR 0014, access.ts): projects own automations; people and teams hold roles on projects,
// on single automations and, in a protected environment, on that environment. A grant names a
// person or a team, never both. Deleting the person, the team or the place deletes the grant.

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: varchar("slug", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectsSlugUnique: uniqueIndex("projects_slug_unique").on(table.slug),
  }),
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 80 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 80 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamsNameUnique: uniqueIndex("teams_name_unique").on(table.normalizedName),
  }),
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamMembersUnique: uniqueIndex("team_members_unique").on(table.teamId, table.userId),
    teamMembersUserIdx: index("team_members_user_idx").on(table.userId),
  }),
);

/**
 * A project's own identity (CONTEXT.md, Service account). It goes with its project, not with the
 * person who created it; its grants and tokens go with it. Like an audit event, it names its
 * creator by id and name without a foreign key, so both outlive the person.
 */
export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 80 }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdByName: text("created_by_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    serviceAccountsNameUnique: uniqueIndex("service_accounts_name_unique").on(
      table.projectId,
      table.normalizedName,
    ),
  }),
);

// A grant names a person, a team or a service account: exactly one of the three columns.
const grantSubject = {
  userId: uuid("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
  teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
  serviceAccountId: uuid("service_account_id").references(() => serviceAccounts.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};
const oneSubject = sql`num_nonnulls(user_id, team_id, service_account_id) = 1`;

/** An environment of a project that only people with an environment grant may reach. */
export const protectedEnvironments = pgTable(
  "protected_environments",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    protectedEnvironmentsPk: primaryKey({ columns: [table.projectId, table.environment] }),
  }),
);

/** A subject's role at one project, automation or protected environment. */
export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    on: varchar("on", { length: 16, enum: ["project", "automation", "environment"] }).notNull(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id").references((): AnyPgColumn => automations.id, {
      onDelete: "cascade",
    }),
    environment: varchar("environment", { length: 32 }),
    ...grantSubject,
    role: varchar("role", { length: 16, enum: PROJECT_ROLES }).notNull(),
  },
  (table) => [
    check("grants_one_subject", oneSubject),
    check("grants_role", inValues(table.role, PROJECT_ROLES)),
    check(
      "grants_target",
      sql`(${table.on} = 'project' AND ${table.automationId} IS NULL AND ${table.environment} IS NULL)
    OR (${table.on} = 'automation' AND ${table.automationId} IS NOT NULL AND ${table.environment} IS NULL)
    OR (${table.on} = 'environment' AND ${table.automationId} IS NULL AND ${table.environment} IS NOT NULL)`,
    ),
    check(
      "grants_admin",
      sql`${table.role} <> 'admin' OR (${table.on} = 'project' AND ${table.serviceAccountId} IS NULL)`,
    ),
    foreignKey({
      columns: [table.projectId, table.environment],
      foreignColumns: [protectedEnvironments.projectId, protectedEnvironments.environment],
      name: "grants_protected_fk",
    }).onDelete("cascade"),
    unique("grants_target_subject_unique")
      .on(
        table.on,
        table.projectId,
        table.automationId,
        table.environment,
        table.userId,
        table.teamId,
        table.serviceAccountId,
      )
      .nullsNotDistinct(),
  ],
);

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Restrict: deleteProject moves or deletes the automations before the project goes.
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    slug: varchar("slug", { length: 120 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description"),
    folderId: uuid("folder_id").references(() => automationFolders.id, { onDelete: "set null" }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationsFolderIdx: index("automations_folder_idx").on(table.folderId, table.name),
    automationsProjectIdx: index("automations_project_idx").on(table.projectId),
    automationsSlugUnique: uniqueIndex("automations_slug_unique").on(table.slug),
  }),
);

/** The automation with this name. */
export function automationNamed(slug: string): SQL {
  return sql`${automations.slug} = ${slug}`;
}

/** The automation's project as a row is written: what a run or an audit event belongs to. */
export function projectOf(automationId: string): SQL<string> {
  return sql<string>`(SELECT ${automations.projectId} FROM ${automations} WHERE ${automations.id} = ${automationId})`;
}

export const automationVersions = pgTable(
  "automation_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    version: varchar("version", { length: 64 }).notNull(),
    entrypoint: varchar("entrypoint", { length: 255 }).notNull(),
    sourceHash: varchar("source_hash", { length: 128 }).notNull(),
    configHash: varchar("config_hash", { length: 64 }).notNull(),
    config: jsonb("config").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationVersionsAutomationCreatedIdx: index("automation_versions_automation_created_idx").on(
      table.automationId,
      table.createdAt,
    ),
    automationVersionsSourceUnique: uniqueIndex("automation_versions_source_unique").on(
      table.automationId,
      table.version,
      table.sourceHash,
      table.configHash,
    ),
  }),
);

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    artifactRootPath: varchar("artifact_root_path", { length: 512 }).notNull(),
    artifactBackend: varchar("artifact_backend", { length: 32 }).notNull(),
    artifactLocator: jsonb("artifact_locator").notNull(),
    manifestPath: varchar("manifest_path", { length: 512 }).notNull(),
    sourceDirectory: varchar("source_directory", { length: 512 }).notNull(),
    runtimeSnapshot: jsonb("runtime_snapshot").notNull(),
    buildSnapshot: jsonb("build_snapshot").$type<StoredBuildSnapshot>().notNull(),
    deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deploymentsAutomationEnvironmentIdx: index("deployments_automation_environment_idx").on(
      table.automationId,
      table.environment,
      table.status,
      table.deployedAt,
    ),
    deploymentsAutomationSeqUnique: uniqueIndex("deployments_automation_seq_unique").on(
      table.automationId,
      table.seq,
    ),
  }),
);

export const automationTriggers = pgTable(
  "automation_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    triggerType: varchar("trigger_type", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    webhookPath: varchar("webhook_path", { length: 255 }),
    cronSchedule: varchar("cron_schedule", { length: 255 }),
    cronIntervalMs: integer("cron_interval_ms"),
    chainSourceAutomationId: uuid("chain_source_automation_id").references(() => automations.id, {
      onDelete: "cascade",
    }),
    chainOnStatus: varchar("chain_on_status", { length: 32 }),
    chainPayloadMode: varchar("chain_payload_mode", { length: 32 }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationTriggersAutomationEnvironmentUnique: uniqueIndex(
      "automation_triggers_automation_environment_unique",
    ).on(table.automationId, table.environment),
    automationTriggersWebhookPathUnique: uniqueIndex("automation_triggers_webhook_path_unique").on(
      table.environment,
      table.webhookPath,
    ),
    automationTriggersStatusNextRunIdx: index("automation_triggers_status_next_run_idx").on(
      table.triggerType,
      table.status,
      table.environment,
      table.nextRunAt,
    ),
    automationTriggersChainSourceIdx: index("automation_triggers_chain_source_idx").on(
      table.chainSourceAutomationId,
      table.environment,
      table.status,
    ),
  }),
);

export const automationTriggerChainSources = pgTable(
  "automation_trigger_chain_sources",
  {
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => automationTriggers.id, { onDelete: "cascade" }),
    sourceAutomationId: uuid("source_automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationTriggerChainSourcesUnique: uniqueIndex("automation_trigger_chain_sources_unique").on(
      table.triggerId,
      table.sourceAutomationId,
    ),
    automationTriggerChainSourcesSourceIdx: index("automation_trigger_chain_sources_source_idx").on(
      table.sourceAutomationId,
    ),
  }),
);

export const automationState = pgTable(
  "automation_state",
  {
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    key: varchar("key", { length: 255 }).notNull(),
    value: jsonb("value").notNull(),
    valueBytes: integer("value_bytes").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationStatePk: uniqueIndex("automation_state_pk").on(
      table.automationId,
      table.environment,
      table.key,
    ),
    automationStateAutomationEnvironmentIdx: index(
      "automation_state_automation_environment_idx",
    ).on(table.automationId, table.environment, table.updatedAt),
  }),
);

// The API check of an automation with `api_check.mode: active`, one row per environment. A deploy
// writes it and makes it due; a check job writes its outcome. Checks are not runs and have no rows
// in `runs`.
export const automationChecks = pgTable(
  "automation_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    entrypoint: varchar("entrypoint", { length: 255 }).notNull(),
    everyMs: bigint("every_ms", { mode: "number" }).notNull(),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastExitCode: integer("last_exit_code"),
    lastOutput: text("last_output"),
    lastReport: jsonb("last_report").$type<ApiCheckReport>(),
    // The connection tokens and secrets the latest check received, never their values: a check
    // keeps only its latest.
    lastConnectionUsages: jsonb("last_connection_usages")
      .$type<readonly StoredConnectionUsage[]>()
      .notNull()
      .default([]),
    lastSecretUsages: jsonb("last_secret_usages")
      .$type<readonly StoredSecretUsage[]>()
      .notNull()
      .default([]),
    lastStderrTail: text("last_stderr_tail"),
    lastWarning: text("last_warning"),
    lastGreenAt: timestamp("last_green_at", { withTimezone: true }),
    lastGreenOutput: text("last_green_output"),
    lastGreenReport: jsonb("last_green_report").$type<ApiCheckReport>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationChecksAutomationEnvironmentUnique: uniqueIndex(
      "automation_checks_automation_environment_unique",
    ).on(table.automationId, table.environment),
    automationChecksEnvironmentNextCheckIdx: index(
      "automation_checks_environment_next_check_idx",
    ).on(table.environment, table.nextCheckAt),
  }),
);

// What an automation's runs and checks saw of each outside API host through the SDK's HTTP helper:
// the last contact and the latest Deprecation or Sunset notice. It never holds a response body.
export const apiContacts = pgTable(
  "api_contacts",
  {
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    host: varchar("host", { length: 255 }).notNull(),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }).notNull(),
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    lastStatus: integer("last_status").notNull(),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    sunsetAt: timestamp("sunset_at", { withTimezone: true }),
    noticePath: text("notice_path"),
    noticeUrl: text("notice_url"),
    noticeSeenAt: timestamp("notice_seen_at", { withTimezone: true }),
    noticeRuns: integer("notice_runs").notNull().default(0),
  },
  (table) => ({
    apiContactsPk: uniqueIndex("api_contacts_pk").on(
      table.automationId,
      table.environment,
      table.host,
    ),
  }),
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey(),
    // A run belongs to the project its automation was in when it started, also after the
    // automation moves (ADR 0014). Deleting the automation deletes its runs (ADR 0015); a project
    // is deleted only after deleteProject moved or deleted its runs, so that key restricts.
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => automationVersions.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    triggerType: varchar("trigger_type", { length: 32 }).notNull(),
    queueName: varchar("queue_name", { length: 120 }).notNull(),
    queueJobId: varchar("queue_job_id", { length: 120 }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<PlatformRunStatus>()
      .notNull()
      .default("queued"),
    payload: jsonb("payload").notNull(),
    webhookContext: jsonb("webhook_context"),
    result: jsonb("result"),
    wait: jsonb("wait").$type<RunWait>(),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    parentStepKey: varchar("parent_step_key", { length: 255 }),
    invokeDepth: integer("invoke_depth").notNull().default(0),
    resumeCount: integer("resume_count").notNull().default(0),
    // The run's step rows and the JSON bytes of their results. Every step write keeps both under a
    // lock on this row (control-plane-steps.ts), so the step limits never read the steps.
    stepCount: integer("step_count").notNull().default(0),
    stepResultBytes: integer("step_result_bytes").notNull().default(0),
    chainOriginRunId: uuid("chain_origin_run_id").references((): AnyPgColumn => runs.id, {
      onDelete: "set null",
    }),
    chainSourceRunIds: uuid("chain_source_run_ids").array().notNull().default(sql`'{}'::uuid[]`),
    stdout: text("stdout").notNull().default(""),
    stderr: text("stderr").notNull().default(""),
    attemptsMax: integer("attempts_max").notNull(),
    attemptsMade: integer("attempts_made").notNull().default(0),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    errorCause: text("error_cause"),
    errorClassification: varchar("error_classification", { length: 32 }),
    deadLetterReason: varchar("dead_letter_reason", { length: 64 }),
    correlationId: varchar("correlation_id", { length: 128 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    terminalPending: boolean("terminal_pending").notNull().default(false),
    /** When a queued run fails with PLACEMENT_TIMEOUT: its queue_timeout from when it last queued. */
    placementDeadlineAt: timestamp("placement_deadline_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runsTerminalPendingIdx: index("runs_terminal_pending_idx")
      .on(table.id)
      .where(sql`${table.terminalPending} = true`),
    runsQueueJobUnique: uniqueIndex("runs_queue_job_unique").on(table.queueJobId),
    runsQueuedAtIdx: index("runs_queued_at_idx").on(table.queuedAt),
    runsStatusQueuedAtIdx: index("runs_status_queued_at_idx").on(table.status, table.queuedAt),
    runsStatusPlacementDeadlineIdx: index("runs_status_placement_deadline_idx").on(
      table.status,
      table.placementDeadlineAt,
    ),
    runsProjectQueuedAtIdx: index("runs_project_queued_at_idx").on(table.projectId, table.queuedAt),
    runsAutomationQueuedAtIdx: index("runs_automation_queued_at_idx").on(
      table.automationId,
      table.queuedAt,
    ),
    runsFinishedAtIdx: index("runs_finished_at_idx").on(table.finishedAt),
    runsParentRunIdx: index("runs_parent_run_idx").on(table.parentRunId),
    runsChainSourceRunIdx: index("runs_chain_source_run_idx").on(table.chainOriginRunId),
    runsChainSourceSucceededIdx: index("runs_chain_source_succeeded_idx").on(
      table.automationId,
      table.chainOriginRunId,
      table.status,
      table.finishedAt,
    ),
    runsStatusWaitUntilIdx: index("runs_status_wait_until_idx").on(
      table.status,
      sql`(${table.wait}->>'until')`,
    ),
  }),
);

export const chainJoinFires = pgTable(
  "chain_join_fires",
  {
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => automationTriggers.id, { onDelete: "cascade" }),
    originRunId: uuid("origin_run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    chainJoinFiresTriggerOriginUnique: uniqueIndex("chain_join_fires_trigger_origin_unique").on(
      table.triggerId,
      table.originRunId,
    ),
    chainJoinFiresRunIdx: index("chain_join_fires_run_idx").on(table.runId),
  }),
);

export const runExecutions = pgTable(
  "run_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    queueJobId: varchar("queue_job_id", { length: 120 }).notNull(),
    /** Counts every execution of the run, resumed ones included. */
    executionNumber: integer("execution_number").notNull(),
    /** The retry attempt this execution spends: `runs.attempts_made` + 1 when it began. */
    attempt: integer("attempt").notNull(),
    /** The wait this execution suspended at; null unless its status is `suspended`. */
    wait: jsonb("wait").$type<ExecutionWait>(),
    /** The name of the worker that claimed the execution, as it was then; a run reader sees it. */
    workerName: varchar("worker_name", { length: 120 }).notNull(),
    phase: varchar("phase", { length: 32, enum: RUN_EXECUTION_PHASES })
      .notNull()
      .default("preparing"),
    status: varchar("status", { length: 32 }).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    errorCause: text("error_cause"),
    errorClassification: varchar("error_classification", { length: 32 }),
    stdout: text("stdout").notNull().default(""),
    stderr: text("stderr").notNull().default(""),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata").notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  },
  (table) => ({
    runExecutionsPhaseCheck: check(
      "run_executions_phase_check",
      inValues(table.phase, RUN_EXECUTION_PHASES),
    ),
    runExecutionsRunExecutionUnique: uniqueIndex("run_executions_run_execution_unique").on(
      table.runId,
      table.executionNumber,
    ),
    runExecutionsRunStartedIdx: index("run_executions_run_started_idx").on(
      table.runId,
      table.startedAt,
    ),
    runExecutionsStatusHeartbeatIdx: index("run_executions_status_heartbeat_idx").on(
      table.status,
      table.lastHeartbeatAt,
    ),
    runExecutionsFinishedAtIdx: index("run_executions_finished_at_idx").on(table.finishedAt),
  }),
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepKey: varchar("step_key", { length: 255 }).notNull(),
    executionNumber: integer("execution_number").notNull(),
    // Null until the step's result arrives; a row without a result is a step that started.
    value: jsonb("value").$type<RunStepResult>(),
    // When the SDK reported step_start; null for a result that arrived without one.
    startedAt: timestamp("started_at", { withTimezone: true }),
    // When the result arrived. Null while the step runs, or when its attempt died inside it.
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runStepsRunKeyUnique: uniqueIndex("run_steps_run_key_unique").on(table.runId, table.stepKey),
    runStepsRunCreatedIdx: index("run_steps_run_created_idx").on(table.runId, table.createdAt),
  }),
);

export const environmentSecrets = pgTable(
  "environment_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // A secret belongs to one environment of one project; only that project's automations get it.
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    ciphertext: text("ciphertext").notNull(),
    algorithm: varchar("algorithm", { length: 32 }).notNull(),
    keyVersion: varchar("key_version", { length: 32 }).notNull(),
    secretVersion: integer("secret_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    environmentSecretsProjectEnvironmentNameUnique: uniqueIndex(
      "environment_secrets_project_environment_name_unique",
    ).on(table.projectId, table.environment, table.name),
    environmentSecretsEnvironmentUpdatedIdx: index(
      "environment_secrets_environment_updated_idx",
    ).on(table.environment, table.updatedAt),
  }),
);

export const runExecutionSecretUsages = pgTable(
  "run_execution_secret_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    executionNumber: integer("execution_number").notNull(),
    environment: varchar("environment", { length: 32 }).notNull(),
    secretName: varchar("secret_name", { length: 120 }).notNull(),
    secretVersion: integer("secret_version").notNull(),
    algorithm: varchar("algorithm", { length: 32 }).notNull(),
    keyVersion: varchar("key_version", { length: 32 }).notNull(),
    injectedAt: timestamp("injected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runExecutionSecretUsagesExecutionSecretUnique: uniqueIndex(
      "run_execution_secret_usages_execution_secret_unique",
    ).on(table.runId, table.executionNumber, table.secretName),
    runExecutionSecretUsagesRunExecutionIdx: index(
      "run_execution_secret_usages_run_execution_idx",
    ).on(table.runId, table.executionNumber, table.injectedAt),
  }),
);

export const environmentConnections = pgTable(
  "environment_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // A connection belongs to one environment of one project, like a secret.
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerConfig: jsonb("provider_config"),
    // OAuth client credentials registered on the provider side. They live on the
    // connection itself: one connection = one account authorized against one
    // client id/secret. The client secret is confidential and reuses the same
    // AES-256-GCM envelope as platform secrets; it never leaves the API/worker.
    clientId: text("client_id").notNull(),
    clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
    clientSecretAlgorithm: varchar("client_secret_algorithm", { length: 32 }).notNull(),
    clientSecretKeyVersion: varchar("client_secret_key_version", { length: 32 }).notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    tokenCiphertext: text("token_ciphertext"),
    tokenAlgorithm: varchar("token_algorithm", { length: 32 }),
    tokenKeyVersion: varchar("token_key_version", { length: 32 }),
    tokenVersion: integer("token_version").notNull().default(0),
    // Plaintext expiry mirror so refresh checks never need to decrypt.
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    pendingStateHash: varchar("pending_state_hash", { length: 64 }),
    pendingCodeVerifierCiphertext: text("pending_code_verifier_ciphertext"),
    pendingRedirectUri: text("pending_redirect_uri"),
    pendingScopes: jsonb("pending_scopes"),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    environmentConnectionsProjectEnvironmentNameUnique: uniqueIndex(
      "environment_connections_project_environment_name_unique",
    ).on(table.projectId, table.environment, table.name),
    environmentConnectionsEnvironmentUpdatedIdx: index(
      "environment_connections_environment_updated_idx",
    ).on(table.environment, table.updatedAt),
    // The state hash is the sole callback lookup key, so it must be globally
    // unique across environments while staying nullable outside authorizations.
    environmentConnectionsPendingStateUnique: uniqueIndex(
      "environment_connections_pending_state_unique",
    )
      .on(table.pendingStateHash)
      .where(sql`${table.pendingStateHash} IS NOT NULL`),
  }),
);

// Credential rights (ADR 0014, access.ts): a secret or a connection is a credential. A person or
// team holds `use` or `manage` on it; a share lets another project's deployments bind it; a
// deployment records the credentials it bound when it was published. Each row names a secret or a
// connection, never both, and deleting the credential deletes its rows.
const oneCredential = sql`(secret_id IS NULL) <> (connection_id IS NULL)`;
const credentialColumns = {
  secretId: uuid("secret_id").references(() => environmentSecrets.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => environmentConnections.id, {
    onDelete: "cascade",
  }),
};

export const credentialGrants = pgTable(
  "credential_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...credentialColumns,
    ...grantSubject,
    role: varchar("role", { length: 16, enum: CREDENTIAL_RIGHTS }).notNull(),
  },
  (table) => ({
    credentialGrantsOneCredential: check("credential_grants_one_credential", oneCredential),
    credentialGrantsOneSubject: check("credential_grants_one_subject", oneSubject),
    credentialGrantsRole: check("credential_grants_role", inValues(table.role, CREDENTIAL_RIGHTS)),
    credentialGrantsSecretUserUnique: uniqueIndex("credential_grants_secret_user_unique").on(
      table.secretId,
      table.userId,
    ),
    credentialGrantsSecretTeamUnique: uniqueIndex("credential_grants_secret_team_unique").on(
      table.secretId,
      table.teamId,
    ),
    credentialGrantsConnectionUserUnique: uniqueIndex(
      "credential_grants_connection_user_unique",
    ).on(table.connectionId, table.userId),
    credentialGrantsConnectionTeamUnique: uniqueIndex(
      "credential_grants_connection_team_unique",
    ).on(table.connectionId, table.teamId),
    credentialGrantsSecretServiceAccountUnique: uniqueIndex(
      "credential_grants_secret_service_account_unique",
    ).on(table.secretId, table.serviceAccountId),
    credentialGrantsConnectionServiceAccountUnique: uniqueIndex(
      "credential_grants_connection_service_account_unique",
    ).on(table.connectionId, table.serviceAccountId),
  }),
);

/**
 * A credential offered to another project in the credential's environment. It binds only once an
 * admin of that project accepted it; deleting it unbinds every deployment that bound through it.
 */
export const credentialShares = pgTable(
  "credential_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...credentialColumns,
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    offeredBy: uuid("offered_by").references(() => authUsers.id, { onDelete: "set null" }),
    acceptedBy: uuid("accepted_by").references(() => authUsers.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    credentialSharesOneCredential: check("credential_shares_one_credential", oneCredential),
    credentialSharesSecretProjectUnique: uniqueIndex("credential_shares_secret_project_unique").on(
      table.secretId,
      table.projectId,
    ),
    credentialSharesConnectionProjectUnique: uniqueIndex(
      "credential_shares_connection_project_unique",
    ).on(table.connectionId, table.projectId),
    credentialSharesProjectIdx: index("credential_shares_project_idx").on(table.projectId),
  }),
);

/**
 * The credentials a deployment bound when it was published: what its runs and checks may receive.
 * `shareId` is set for a credential of another project.
 */
export const deploymentCredentials = pgTable(
  "deployment_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    ...credentialColumns,
    shareId: uuid("share_id").references(() => credentialShares.id, { onDelete: "cascade" }),
  },
  (table) => ({
    deploymentCredentialsOneCredential: check(
      "deployment_credentials_one_credential",
      oneCredential,
    ),
    deploymentCredentialsDeploymentIdx: index("deployment_credentials_deployment_idx").on(
      table.deploymentId,
    ),
    deploymentCredentialsSecretIdx: index("deployment_credentials_secret_idx").on(table.secretId),
    deploymentCredentialsConnectionIdx: index("deployment_credentials_connection_idx").on(
      table.connectionId,
    ),
  }),
);

export const runExecutionConnectionUsages = pgTable(
  "run_execution_connection_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    executionNumber: integer("execution_number").notNull(),
    environment: varchar("environment", { length: 32 }).notNull(),
    connectionName: varchar("connection_name", { length: 120 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    tokenVersion: integer("token_version").notNull(),
    injectedAt: timestamp("injected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runExecutionConnectionUsagesExecutionConnectionUnique: uniqueIndex(
      "run_execution_connection_usages_execution_connection_unique",
    ).on(table.runId, table.executionNumber, table.connectionName),
    runExecutionConnectionUsagesRunExecutionIdx: index(
      "run_execution_connection_usages_run_execution_idx",
    ).on(table.runId, table.executionNumber, table.injectedAt),
  }),
);

export const automationTimeoutGrants = pgTable(
  "automation_timeout_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    // Per-automation override of SWIZZLE_MAX_RUN_TIMEOUT. Stored as milliseconds
    // in a bigint so long ceilings (multi-hour) stay exact.
    maxTimeoutMs: bigint("max_timeout_ms", { mode: "number" }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    automationTimeoutGrantsAutomationEnvironmentUnique: uniqueIndex(
      "automation_timeout_grants_automation_environment_unique",
    ).on(table.automationId, table.environment),
    automationTimeoutGrantsMaxTimeoutPositive: check(
      "automation_timeout_grants_max_timeout_ms_positive",
      sql`${table.maxTimeoutMs} > 0`,
    ),
  }),
);

export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Null on a rule that covers every automation of the project in the environment.
    automationId: uuid("automation_id").references(() => automations.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull().default("telegram"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    chatId: varchar("chat_id", { length: 120 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    threshold: integer("threshold").notNull().default(1),
    windowSeconds: integer("window_seconds").notNull().default(3600),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(900),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    notificationRulesAutomationEventIdx: index("notification_rules_automation_event_idx").on(
      table.automationId,
      table.environment,
      table.eventType,
      table.enabled,
    ),
    notificationRulesProjectIdx: index("notification_rules_project_idx").on(
      table.projectId,
      table.environment,
    ),
    notificationRulesUserIdx: index("notification_rules_user_idx").on(table.userId),
  }),
);

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").references(() => notificationRules.id, { onDelete: "set null" }),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull().default("telegram"),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    chatId: varchar("chat_id", { length: 120 }).notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    dedupeKey: varchar("dedupe_key", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 120 }),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    notificationDeliveriesPendingIdx: index("notification_deliveries_pending_idx")
      .on(table.id)
      .where(sql`${table.status} = 'pending'`),
    notificationDeliveriesDedupeUnique: uniqueIndex("notification_deliveries_dedupe_unique").on(
      table.dedupeKey,
    ),
    notificationDeliveriesEnvironmentCreatedIdx: index(
      "notification_deliveries_environment_created_idx",
    ).on(table.environment, table.createdAt),
    notificationDeliveriesRuleCreatedIdx: index("notification_deliveries_rule_created_idx").on(
      table.ruleId,
      table.createdAt,
    ),
  }),
);

/**
 * The instance audit (audit.ts). No foreign key on purpose: deleting an automation, a project, a
 * person or a token leaves every event and its labels readable.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorKind: varchar("actor_kind", { length: 24 }).notNull(),
    // The person, service account or worker; null for links, anonymous callers, the system and the host.
    actorId: uuid("actor_id"),
    actorLabel: varchar("actor_label", { length: 320 }),
    actorRole: varchar("actor_role", { length: 16, enum: INSTANCE_ROLES }),
    tokenId: uuid("token_id"),
    action: varchar("action", { length: 200 }).notNull(),
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    projectId: uuid("project_id"),
    automationId: uuid("automation_id"),
    automationSlug: varchar("automation_slug", { length: 120 }),
    runId: uuid("run_id"),
    deploymentId: uuid("deployment_id"),
    triggerId: uuid("trigger_id"),
    workerId: uuid("worker_id"),
    environment: varchar("environment", { length: 32 }),
    privileged: boolean("privileged").notNull().default(false),
    status: integer("status"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    change: jsonb("change").$type<import("./audit.js").AuditChange>(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
  },
  (table) => ({
    auditEventsActorKind: check(
      "audit_events_actor_kind",
      sql`${table.actorKind} IN ('person', 'service-account', 'link', 'anonymous', 'worker', 'system', 'host')`,
    ),
    auditEventsOccurredIdx: index("audit_events_occurred_idx").on(table.occurredAt),
    auditEventsProjectIdx: index("audit_events_project_idx").on(table.projectId, table.occurredAt),
    auditEventsAutomationIdx: index("audit_events_automation_idx").on(
      table.automationSlug,
      table.occurredAt,
    ),
    auditEventsAutomationIdIdx: index("audit_events_automation_id_idx").on(
      table.automationId,
      table.environment,
      table.occurredAt,
    ),
    auditEventsWorkerIdx: index("audit_events_worker_idx").on(table.workerId, table.occurredAt),
    auditEventsActorIdx: index("audit_events_actor_idx").on(table.actorId, table.occurredAt),
  }),
);

export const queueMetricSamples = pgTable(
  "queue_metric_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environment: varchar("environment", { length: 32 }).notNull(),
    queueName: varchar("queue_name", { length: 120 }).notNull(),
    active: integer("active").notNull().default(0),
    waiting: integer("waiting").notNull().default(0),
    completed: integer("completed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    delayed: integer("delayed").notNull().default(0),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    queueMetricSamplesEnvironmentObservedIdx: index(
      "queue_metric_samples_environment_observed_idx",
    ).on(table.environment, table.queueName, table.observedAt),
  }),
);

export const maintenanceRuns = pgTable(
  "maintenance_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environment: varchar("environment", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    summary: jsonb("summary").notNull().default({}),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    maintenanceRunsEnvironmentStartedIdx: index("maintenance_runs_environment_started_idx").on(
      table.environment,
      table.startedAt,
    ),
  }),
);

/**
 * API tokens. A personal token acts as its person, with their rights at the time of each request; a
 * service account token acts as its account. Either is capped by the scope it was minted with
 * (access.ts, TokenScope): `project_ids` and `environments` null mean every one. The person who
 * issued it is named by id and name without a foreign key, so both outlive them; a worker's
 * credential has none.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    serviceAccountId: uuid("service_account_id").references(() => serviceAccounts.id, {
      onDelete: "cascade",
    }),
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    tokenPrefix: varchar("token_prefix", { length: 12 }).notNull(),
    role: varchar("role", { length: 16, enum: PROJECT_ROLES }).notNull(),
    projectIds: uuid("project_ids").array(),
    environments: varchar("environments", { length: 32 }).array(),
    issuedBy: uuid("issued_by"),
    issuedByName: text("issued_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    apiTokensOneHolder: check(
      "api_tokens_one_holder",
      sql`num_nonnulls(user_id, service_account_id, worker_id) = 1`,
    ),
    apiTokensRole: check("api_tokens_role", inValues(table.role, PROJECT_ROLES)),
    apiTokensIssuer: check(
      "api_tokens_issuer",
      sql`(issued_by IS NULL) = (issued_by_name IS NULL)`,
    ),
    // A revoked token keeps its name for the record; rotation reuses it.
    apiTokensUserNameUnique: uniqueIndex("api_tokens_user_name_unique")
      .on(table.userId, table.name)
      .where(sql`${table.revokedAt} IS NULL`),
    apiTokensServiceAccountNameUnique: uniqueIndex("api_tokens_service_account_name_unique")
      .on(table.serviceAccountId, table.name)
      .where(sql`${table.revokedAt} IS NULL`),
    apiTokensWorkerUnique: uniqueIndex("api_tokens_worker_unique")
      .on(table.workerId)
      .where(sql`${table.revokedAt} IS NULL`),
    apiTokensTokenHashUnique: uniqueIndex("api_tokens_token_hash_unique").on(table.tokenHash),
  }),
);

// Sign-in for people. Better Auth reads and writes these tables through its Drizzle adapter, so
// their JS property names are Better Auth's field names (packages/db/src/auth.ts maps the models).
// Ids are UUIDs PostgreSQL generates; Better Auth leaves them out of each insert.

export const authUsers = pgTable(
  "auth_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 160 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // The instance role (access.ts); the first account is the owner (auth-guarantees.ts).
    role: varchar("role", { length: 16, enum: INSTANCE_ROLES }).notNull().default("member"),
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    // Set while an owner or admin suspends the person: no session, no working token.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authUsersEmailUnique: uniqueIndex("auth_users_email_unique").on(table.email),
    authUsersRole: check("auth_users_role", inValues(table.role, INSTANCE_ROLES)),
  }),
);

/** `token` holds the SHA-256 hash of the cookie's token (auth-session-store.ts). */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull(),
    // The sign-in this session descends from; the absolute limit counts from it.
    signedInAt: timestamp("signed_in_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authSessionsTokenUnique: uniqueIndex("auth_sessions_token_unique").on(table.token),
    authSessionsUserIdx: index("auth_sessions_user_idx").on(table.userId),
  }),
);

/** A sign-in method of a user; `password` holds the scrypt hash for the "credential" provider. */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authAccountsUserIdx: index("auth_accounts_user_idx").on(table.userId),
  }),
);

/** Short-lived single-use values, such as the challenge between password and code. */
export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authVerificationsIdentifierIdx: index("auth_verifications_identifier_idx").on(table.identifier),
  }),
);

/**
 * A user's TOTP factor. Better Auth encrypts the secret and the recovery codes with a key derived
 * from SWIZZLE_ENCRYPTION_KEY. `verified` is false while enrollment awaits a code.
 */
export const authTwoFactors = pgTable(
  "auth_two_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => ({
    authTwoFactorsUserUnique: uniqueIndex("auth_two_factors_user_unique").on(table.userId),
  }),
);

/** Accepted TOTP codes, hashed with their person, retained through the acceptance window. */
export const authTotpUses = pgTable(
  "auth_totp_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    authTotpUsesCodeUnique: uniqueIndex("auth_totp_uses_code_unique").on(table.codeHash),
    authTotpUsesExpiresIdx: index("auth_totp_uses_expires_idx").on(table.expiresAt),
  }),
);

/** A browser that signed in to this account. It spends its own sign-in budget. */
export const authDevices = pgTable(
  "auth_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authDevicesTokenHashUnique: uniqueIndex("auth_devices_token_hash_unique").on(table.tokenHash),
  }),
);

/**
 * An invitation to join the instance (auth-membership.ts). Its mail carries the token; `tokenHash`
 * is its SHA-256. `grants` are the project grants it promises, `[{ projectId, role }]`, given once
 * the recipient has an account. Accepting sets `acceptedAt` in the transaction that inserts that
 * account; `grantedAt` follows when the grants are in place.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 320 }).notNull(),
    role: varchar("role", { length: 16, enum: INSTANCE_ROLES }).notNull(),
    grants: jsonb("grants").$type<readonly PendingGrant[]>().notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    invitedBy: uuid("invited_by").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    userId: uuid("user_id").references(() => authUsers.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
  },
  (table) => ({
    invitationsTokenHashUnique: uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
    invitationsEmailIdx: index("invitations_email_idx").on(table.email),
    invitationsUserIdx: index("invitations_user_idx").on(table.userId),
    invitationsRole: check("invitations_role", inValues(table.role, INSTANCE_ROLES)),
  }),
);

/** Sign-in attempts spent per budget and scope in the current window (auth-guarantees.ts). */
export const authBudgets = pgTable(
  "auth_budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull(),
    windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    authBudgetsKeyUnique: uniqueIndex("auth_budgets_key_unique").on(table.keyHash),
    authBudgetsWindowIdx: index("auth_budgets_window_idx").on(table.windowEndsAt),
  }),
);

export const platformEnvironments = pgTable("platform_environments", {
  name: varchar("name", { length: 32 }).primaryKey(),
  displayName: varchar("display_name", { length: 80 }),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const serviceHeartbeats = pgTable(
  "service_heartbeats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    service: varchar("service", { length: 32 }).notNull(),
    instanceId: varchar("instance_id", { length: 120 }).notNull(),
    environment: varchar("environment", { length: 32 }).notNull(),
    host: varchar("host", { length: 255 }),
    pid: integer("pid"),
    metadata: jsonb("metadata").notNull().default({}),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    serviceHeartbeatsServiceInstanceUnique: uniqueIndex(
      "service_heartbeats_service_instance_unique",
    ).on(table.service, table.instanceId),
    serviceHeartbeatsEnvironmentObservedIdx: index(
      "service_heartbeats_environment_observed_idx",
    ).on(table.environment, table.service, table.observedAt),
  }),
);

/** Worker authority is independent of personal API tokens and project roles (ADR 0013). */
export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 120 }).notNull(),
  local: boolean("local").notNull().default(false),
  capacity: integer("capacity").notNull().default(1),
  draining: boolean("draining").notNull().default(false),
  profiles: text("profiles").array().notNull(),
  services: text("services").array().$type<WorkerService[]>().notNull(),
  enrollmentHash: text("enrollment_hash").unique(),
  enrollmentExpiresAt: timestamp("enrollment_expires_at", { withTimezone: true }).notNull(),
  credentialGeneration: integer("credential_generation").notNull().default(0),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  runImageDisk: jsonb("run_image_disk").$type<import("./workers.js").RunImageDisk>(),
  /** What the worker's host can run, from its last heartbeat; deploy readiness reads it. */
  capabilities: jsonb("capabilities").$type<import("./workers.js").WorkerCapabilities>(),
  /** The services' health from the worker's last runtime report; placement trusts it for a minute. */
  serviceHealth: jsonb("service_health")
    .$type<import("./workers.js").ServiceHealthReport>()
    .notNull()
    .default({}),
  serviceHealthAt: timestamp("service_health_at", { withTimezone: true }),
});

/** A worker reports a deployment's image tag before assembling or reusing it. */
export const workerRunImages = pgTable(
  "worker_run_images",
  {
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
    tag: varchar("tag", { length: 36 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.deploymentId, table.workerId] })],
);

/** Machine execution grants have no role and disappear with their project or worker. */
export const workerGrants = pgTable(
  "worker_grants",
  {
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environment: varchar("environment", { length: 32 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workerId, table.projectId, table.environment] })],
);

/** One durable owner per run. Generations are retained when a lease is released. */
export const executionLeases = pgTable(
  "execution_leases",
  {
    taskId: text("task_id").primaryKey(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "cascade" }),
    checkId: uuid("check_id").references(() => automationChecks.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id),
    generation: integer("generation").notNull(),
    executionNumber: integer("execution_number").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    released: boolean("released").notNull().default(false),
    resultDigest: text("result_digest"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    /** When the worker fetched the execution's secrets. Unstarted leases spend no attempt. */
    startedAt: timestamp("started_at", { withTimezone: true }),
    /**
     * The prepared execution's ExecutionState (dispatch.ts), sealed with SWIZZLE_ENCRYPTION_KEY: it
     * holds the delivered secrets. Cleared when the lease is released.
     */
    executionState: text("execution_state"),
  },
  (table) => [
    index("execution_leases_active_idx").on(table.expiresAt).where(sql`${table.released} = false`),
    index("execution_leases_worker_expiry_idx").on(table.workerId, table.expiresAt),
    check(
      "execution_leases_one_target",
      sql`(${table.runId} is not null and ${table.checkId} is null and ${table.dueAt} is null) or (${table.runId} is null and ${table.checkId} is not null and ${table.dueAt} is not null)`,
    ),
  ],
);

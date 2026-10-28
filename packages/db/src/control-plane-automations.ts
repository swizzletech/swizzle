/**
 * Deleting and moving an automation, and deleting the project that holds automations (ADR 0014,
 * ADR 0015). Deleting an automation deletes its runs with it; only audit events, which have no
 * foreign key, stay. Moving keeps runs in the project they were written in. Both refuse while a
 * trigger is active, so nothing starts in the middle; delete also refuses while a run is
 * unfinished, since its rows would vanish under the worker. Each locks the automation rows for
 * update; run creation and trigger status changes hold them shared (`shareLiveAutomation`), so
 * neither lands between a check here and its commit.
 *
 * Deleting a project moves its automations, credentials and runs to another project or deletes
 * them, in one transaction with the project row (`deleteProject`). It locks the automations
 * before the project rows, the order in which run creation reaches them.
 */
import { and, count, eq, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import { DEFAULT_PROJECT_ID } from "./access.js";
import type { DatabaseClient } from "./client.js";
import { CodedError, chainMoveConflict } from "./coded-error.js";
import { deleteConnectionsWhere } from "./control-plane-connections.js";
import type {
  DeleteAutomationArtifactRef,
  DeleteAutomationInput,
  DeleteAutomationResult,
  DeleteProjectInput,
  DeleteProjectResult,
  MoveAutomationInput,
  MovedAutomation,
  ProjectContentCounts,
  StoredArtifactLocator,
  StoredArtifactStorageBackend,
} from "./control-plane-types.js";
import { OPEN_RUN_STATUSES } from "./run-status.js";
import {
  auditEvents,
  automationNamed,
  automations,
  automationTriggerChainSources,
  automationTriggers,
  credentialShares,
  deploymentCredentials,
  deployments,
  environmentConnections,
  environmentSecrets,
  grants,
  notificationRules,
  projects,
  runs,
} from "./schema.js";

type Transaction = Parameters<Parameters<DatabaseClient["db"]["transaction"]>[0]>[0];

/**
 * The automation `match` names, share-locked until `tx` ends; null once it is deleted. A move or
 * delete in flight makes this wait, and it then reads the row as they left it.
 */
export async function shareLiveAutomation(
  tx: Transaction,
  match: SQL,
): Promise<{ readonly id: string; readonly projectId: string } | null> {
  const [automation] = await tx
    .select({ id: automations.id, projectId: automations.projectId })
    .from(automations)
    .where(match)
    .limit(1)
    .for("share");
  return automation ?? null;
}

export async function deleteAutomation(
  client: DatabaseClient,
  input: DeleteAutomationInput,
): Promise<DeleteAutomationResult> {
  return await client.db.transaction(async (tx) => {
    const automation = await lockAutomation(tx, input.automationSlug);
    await refuseActiveTriggers(tx, automation);
    const unfinished = await countUnfinishedRuns(tx, eq(runs.automationId, automation.id));
    if (unfinished > 0) {
      throw new CodedError(
        "AUTOMATION_RUNS_ACTIVE",
        `${automation.slug} has ${unfinished} unfinished runs. Cancel them or let them finish, then delete it.`,
        { details: { unfinishedRuns: unfinished } },
      );
    }

    const [references] = await artifactReferencesOf(tx, [automation.id]);
    const deletedCounts = await removeAutomations(tx, [automation.id]);
    const [kept] = await tx
      .select({ rows: count() })
      .from(auditEvents)
      .where(eq(auditEvents.automationId, automation.id));
    return {
      artifactReferences: references?.artifactReferences ?? [],
      automationId: automation.id,
      automationName: automation.name,
      automationSlug: automation.slug,
      deletedCounts,
      kept: { auditEvents: kept?.rows ?? 0 },
      projectId: automation.projectId,
    };
  });
}

export async function listAutomationChainDependents(
  client: DatabaseClient,
  automationSlug: string,
) {
  const [source] = await client.db
    .select({ id: automations.id })
    .from(automations)
    .where(automationNamed(automationSlug));
  if (source === undefined) return [];
  return await client.db
    .selectDistinct({
      automationId: automations.id,
      automationSlug: automations.slug,
      projectId: automations.projectId,
      environment: automationTriggers.environment,
    })
    .from(automationTriggers)
    .innerJoin(automations, eq(automations.id, automationTriggers.automationId))
    .leftJoin(
      automationTriggerChainSources,
      eq(automationTriggerChainSources.triggerId, automationTriggers.id),
    )
    .where(
      and(
        eq(automationTriggers.triggerType, "chain"),
        or(
          eq(automationTriggers.chainSourceAutomationId, source.id),
          eq(automationTriggerChainSources.sourceAutomationId, source.id),
        ),
      ),
    )
    .orderBy(automations.slug, automationTriggers.environment);
}

export async function countProjectContents(
  client: DatabaseClient,
  projectId: string,
): Promise<ProjectContentCounts | null> {
  const [project] = await client.db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (project === undefined) return null;
  return await countContents(client.db, projectId);
}

export async function deleteProject(
  client: DatabaseClient,
  input: DeleteProjectInput,
): Promise<DeleteProjectResult> {
  const { contents, projectId } = input;
  if (projectId === DEFAULT_PROJECT_ID) {
    throw new CodedError("PROJECT_PROTECTED", "The default project cannot be deleted.");
  }
  if (contents?.kind === "move" && contents.projectId === projectId) {
    throw new CodedError("REQUEST_INVALID", "Move the contents to another project.");
  }
  return await client.db.transaction(async (tx) => {
    // Automations before projects: run creation holds its automation shared and then needs the
    // project for the run's foreign key, so taking the project first deadlocks with it.
    await lockAutomationsOf(tx, projectId);
    // Both projects of a move in id order, so two moves in opposite directions wait in turn.
    const locks: [string, "share" | "update"][] = [[projectId, "update"]];
    if (contents?.kind === "move") locks.push([contents.projectId, "share"]);
    for (const [id, strength] of locks.sort(([left], [right]) => left.localeCompare(right))) {
      await lockProject(tx, id, strength);
    }
    // The project lock stops new automations; this takes any created before it.
    const automationIds = await lockAutomationsOf(tx, projectId);
    const counts = await countContents(tx, projectId);
    const empty = counts.automations + counts.credentials + counts.runs === 0;
    const result = {
      counts,
      deletedAutomations: [] as DeleteProjectResult["deletedAutomations"],
      deletedConnections: [] as DeleteProjectResult["deletedConnections"],
      projectId,
    };

    if (contents === null) {
      if (!empty) throw projectNotEmpty(counts);
    } else if (contents.kind === "move") {
      await moveProjectContents(tx, projectId, contents.projectId, automationIds);
    } else {
      const unfinished = await countUnfinishedRuns(
        tx,
        or(eq(runs.projectId, projectId), inArray(runs.automationId, automationIds)),
      );
      if (unfinished > 0) {
        throw new CodedError(
          "AUTOMATION_RUNS_ACTIVE",
          `The project has ${unfinished} unfinished runs. Cancel them or let them finish, then delete it.`,
          { details: { unfinishedRuns: unfinished } },
        );
      }
      result.deletedAutomations = await artifactReferencesOf(tx, automationIds);
      await removeAutomations(tx, automationIds);
      // Runs written here by an automation that has since moved to another project.
      await tx.delete(runs).where(eq(runs.projectId, projectId));
      result.deletedConnections = await deleteConnectionsWhere(
        tx,
        eq(environmentConnections.projectId, projectId),
      );
    }

    // Secrets, folders, grants, service accounts, protected environments and credential shares
    // the project accepted go with its row.
    await tx.delete(projects).where(eq(projects.id, projectId));
    return { ...result, contents: contents === null ? "empty" : contents.kind };
  });
}

/**
 * Moves what a project holds to `to`: automations (without their folder), secrets, connections,
 * the rules that name a moved automation, and the runs written in the project. A credential
 * whose name `to` already uses in that environment refuses the move. A share between the two
 * projects becomes pointless once the credential lives where it was accepted, so the deployments
 * that bound through it keep the credential directly; shares from third projects end with the
 * project that accepted them.
 */
async function moveProjectContents(
  tx: Transaction,
  from: string,
  to: string,
  automationIds: readonly string[],
): Promise<void> {
  const conflicts = [
    ...(await credentialNameConflicts(tx, environmentSecrets, from, to)),
    ...(await credentialNameConflicts(tx, environmentConnections, from, to)),
  ];
  if (conflicts.length > 0) {
    throw new CodedError(
      "CREDENTIAL_NAME_CONFLICT",
      `The target project already has ${conflicts.map((conflict) => `${conflict.name} in ${conflict.environment}`).join(", ")}. Rename or delete them in one of the projects, then delete again.`,
      { details: { conflicts } },
    );
  }
  for (const table of [environmentSecrets, environmentConnections]) {
    await tx.update(table).set({ projectId: to }).where(eq(table.projectId, from));
  }
  const pointless = sql`(
    SELECT ${credentialShares.id} FROM ${credentialShares}
    LEFT JOIN ${environmentSecrets} ON ${environmentSecrets.id} = ${credentialShares.secretId}
    LEFT JOIN ${environmentConnections} ON ${environmentConnections.id} = ${credentialShares.connectionId}
    WHERE ${credentialShares.projectId} IN (${from}, ${to})
      AND COALESCE(${environmentSecrets.projectId}, ${environmentConnections.projectId}) = ${to}
  )`;
  await tx
    .update(deploymentCredentials)
    .set({ shareId: null })
    .where(sql`${deploymentCredentials.shareId} IN ${pointless}`);
  await tx.delete(credentialShares).where(sql`${credentialShares.id} IN ${pointless}`);

  await tx
    .update(automations)
    .set({ folderId: null, projectId: to, updatedAt: new Date() })
    .where(eq(automations.projectId, from));
  if (automationIds.length > 0) {
    await tx
      .update(notificationRules)
      .set({ projectId: to, updatedAt: new Date() })
      .where(inArray(notificationRules.automationId, automationIds));
  }
  await tx.update(runs).set({ projectId: to }).where(eq(runs.projectId, from));
}

async function credentialNameConflicts(
  tx: Transaction,
  table: typeof environmentSecrets | typeof environmentConnections,
  from: string,
  to: string,
): Promise<readonly { readonly environment: string; readonly name: string }[]> {
  return await tx
    .select({ environment: table.environment, name: table.name })
    .from(table)
    .where(
      and(
        eq(table.projectId, from),
        sql`EXISTS (SELECT 1 FROM ${table} AS taken WHERE taken.project_id = ${to}
          AND taken.environment = ${table.environment} AND taken.name = ${table.name})`,
      ),
    )
    .orderBy(table.environment, table.name);
}

async function countContents(
  db: Pick<DatabaseClient["db"], "select">,
  projectId: string,
): Promise<ProjectContentCounts> {
  const rows = async (
    table:
      | typeof automations
      | typeof environmentSecrets
      | typeof environmentConnections
      | typeof runs,
  ) =>
    (await db.select({ rows: count() }).from(table).where(eq(table.projectId, projectId)))[0]
      ?.rows ?? 0;
  const automationCount = await rows(automations);
  const secretCount = await rows(environmentSecrets);
  const connectionCount = await rows(environmentConnections);
  const runCount = await rows(runs);
  return {
    automations: automationCount,
    credentials: secretCount + connectionCount,
    runs: runCount,
  };
}

function projectNotEmpty(counts: ProjectContentCounts): CodedError {
  return new CodedError(
    "PROJECT_NOT_EMPTY",
    `The project holds ${counts.automations} automations, ${counts.credentials} credentials and ${counts.runs} runs. Move them to another project (contents=move&to=<project>) or delete them with it (contents=delete).`,
    { details: { ...counts } },
  );
}

async function lockAutomationsOf(tx: Transaction, projectId: string): Promise<string[]> {
  const owned = await tx
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.projectId, projectId))
    .orderBy(automations.id)
    .for("update");
  return owned.map((row) => row.id);
}

async function lockProject(tx: Transaction, projectId: string, strength: "share" | "update") {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for(strength);
  if (project === undefined) {
    throw new CodedError("PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }
}

async function countUnfinishedRuns(tx: Transaction, where: SQL | undefined): Promise<number> {
  const [unfinished] = await tx
    .select({ runs: count() })
    .from(runs)
    .where(and(where, inArray(runs.status, OPEN_RUN_STATUSES)));
  return unfinished?.runs ?? 0;
}

async function artifactReferencesOf(
  tx: Transaction,
  automationIds: readonly string[],
): Promise<DeleteProjectResult["deletedAutomations"]> {
  if (automationIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({
      artifactBackend: deployments.artifactBackend,
      artifactLocator: deployments.artifactLocator,
      artifactRootPath: deployments.artifactRootPath,
      automationSlug: automations.slug,
    })
    .from(automations)
    .leftJoin(deployments, eq(deployments.automationId, automations.id))
    .where(inArray(automations.id, [...automationIds]))
    .orderBy(automations.slug);
  const bySlug = new Map<string, DeleteAutomationArtifactRef[]>();
  for (const row of rows) {
    const references = bySlug.get(row.automationSlug) ?? [];
    if (row.artifactBackend !== null && row.artifactRootPath !== null) {
      references.push({
        artifactBackend: row.artifactBackend as StoredArtifactStorageBackend,
        artifactLocator: row.artifactLocator as StoredArtifactLocator,
        artifactRootPath: row.artifactRootPath,
      });
    }
    bySlug.set(row.automationSlug, references);
  }
  return [...bySlug].map(([automationSlug, artifactReferences]) => ({
    artifactReferences,
    automationSlug,
  }));
}

/**
 * Deletes the automations with everything that cascades from them: versions, deployments,
 * triggers, state, checks, grants, rules and runs with their attempts, steps and logs. A chain
 * trigger of another automation that names one of them stays invalid, so its owner can see why
 * it cannot fire, and a join never fires on fewer sources than it declared.
 */
async function removeAutomations(
  tx: Transaction,
  automationIds: readonly string[],
): Promise<DeleteAutomationResult["deletedCounts"]> {
  if (automationIds.length === 0) return { deployments: 0, runs: 0 };
  const ids = [...automationIds];
  const [deploymentCount] = await tx
    .select({ rows: count() })
    .from(deployments)
    .where(inArray(deployments.automationId, ids));
  const [runCount] = await tx
    .select({ rows: count() })
    .from(runs)
    .where(inArray(runs.automationId, ids));
  const sources = await tx
    .select({ id: automations.id, slug: automations.slug })
    .from(automations)
    .where(inArray(automations.id, ids));
  for (const source of sources) {
    await tx
      .update(automationTriggers)
      .set({
        // Clear the single-source FK before deleting its target, or its cascade removes the trigger.
        chainSourceAutomationId: null,
        status: "invalid",
        errorCode: "TRIGGER_CHAIN_SOURCE_DELETED",
        errorMessage: `Chain source automation was deleted: ${source.slug}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automationTriggers.triggerType, "chain"),
          or(
            eq(automationTriggers.chainSourceAutomationId, source.id),
            inArray(
              automationTriggers.id,
              tx
                .select({ id: automationTriggerChainSources.triggerId })
                .from(automationTriggerChainSources)
                .where(eq(automationTriggerChainSources.sourceAutomationId, source.id)),
            ),
          ),
        ),
      );
  }
  await tx.delete(automations).where(inArray(automations.id, ids));
  return { deployments: deploymentCount?.rows ?? 0, runs: runCount?.rows ?? 0 };
}

export async function moveAutomation(
  client: DatabaseClient,
  input: MoveAutomationInput,
): Promise<MovedAutomation> {
  return await client.db.transaction(async (tx) => {
    const automation = await lockAutomation(tx, input.automationSlug);
    if (automation.projectId === input.projectId) {
      return {
        automationId: automation.id,
        automationSlug: automation.slug,
        moved: false,
        projectId: automation.projectId,
      };
    }
    const connections = await tx
      .selectDistinct({
        automationSlug: automations.slug,
      })
      .from(automationTriggers)
      .leftJoin(
        automationTriggerChainSources,
        eq(automationTriggerChainSources.triggerId, automationTriggers.id),
      )
      .innerJoin(
        automations,
        or(
          and(
            eq(automationTriggers.automationId, automation.id),
            or(
              eq(automations.id, automationTriggers.chainSourceAutomationId),
              eq(automations.id, automationTriggerChainSources.sourceAutomationId),
            ),
          ),
          and(
            eq(automations.id, automationTriggers.automationId),
            or(
              eq(automationTriggers.chainSourceAutomationId, automation.id),
              eq(automationTriggerChainSources.sourceAutomationId, automation.id),
            ),
          ),
        ),
      )
      .where(eq(automationTriggers.triggerType, "chain"));
    if (connections.length > 0)
      throw chainMoveConflict(
        automation.slug,
        connections.map((connection) => connection.automationSlug),
      );
    await refuseActiveTriggers(tx, automation);
    // A share was given in the old project; the new project's admins decide who sees it there.
    await tx.delete(grants).where(eq(grants.automationId, automation.id));
    await tx
      .update(automations)
      .set({ folderId: null, projectId: input.projectId, updatedAt: new Date() })
      .where(eq(automations.id, automation.id));
    return {
      automationId: automation.id,
      automationSlug: automation.slug,
      moved: true,
      projectId: input.projectId,
    };
  });
}

async function lockAutomation(tx: Transaction, automationSlug: string) {
  const [automation] = await tx
    .select({
      id: automations.id,
      name: automations.name,
      projectId: automations.projectId,
      slug: automations.slug,
    })
    .from(automations)
    .where(automationNamed(automationSlug))
    .limit(1)
    .for("update");
  if (automation === undefined) {
    throw new CodedError("AUTOMATION_NOT_FOUND", `Automation not found: ${automationSlug}`);
  }
  return automation;
}

async function refuseActiveTriggers(
  tx: Transaction,
  automation: { readonly id: string; readonly slug: string },
): Promise<void> {
  const active = await tx
    .select({ environment: automationTriggers.environment })
    .from(automationTriggers)
    .where(
      and(
        eq(automationTriggers.automationId, automation.id),
        ne(automationTriggers.status, "paused"),
      ),
    )
    .orderBy(automationTriggers.environment);
  if (active.length === 0) return;
  const environments = active.map((row) => row.environment);
  throw new CodedError(
    "AUTOMATION_NOT_PAUSED",
    `The trigger of ${automation.slug} is active in ${environments.join(", ")}. Pause it there first: \`swizzle trigger pause ${automation.slug} -e <environment>\`.`,
    { details: { activeEnvironments: environments } },
  );
}

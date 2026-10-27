import { and, asc, eq, inArray, max } from "drizzle-orm";

import type { AutomationFolder } from "./automation-folder-types.js";
import { causeCode, createDatabaseClient, type DatabaseClient, PG_ERROR } from "./client.js";
import { automationFolders, automationNamed, automations } from "./schema.js";

export type AutomationFolderMutationResult =
  | { readonly folder: AutomationFolder; readonly status: "ok" }
  | { readonly status: "name-conflict" | "not-found" };

export type AutomationFolderAssignmentResult =
  | { readonly folderId: string | null; readonly status: "ok" }
  | { readonly status: "automation-not-found" | "folder-not-found" };

export interface AutomationFolderStore {
  close(): Promise<void>;
  /** "folder-not-found" also for a folder of another project than the automation's. */
  assignAutomation(
    automationSlug: string,
    folderId: string | null,
  ): Promise<AutomationFolderAssignmentResult>;
  createFolder(projectId: string, name: string): Promise<AutomationFolderMutationResult>;
  deleteFolder(folderId: string): Promise<boolean>;
  getFolder(folderId: string): Promise<AutomationFolder | null>;
  /** The folders of these projects; every project's with "all". */
  listFolders(projectIds: readonly string[] | "all"): Promise<readonly AutomationFolder[]>;
  renameFolder(folderId: string, name: string): Promise<AutomationFolderMutationResult>;
}

export class AutomationFolderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationFolderValidationError";
  }
}

export function createAutomationFolderStore(
  options: { readonly client?: DatabaseClient; readonly connectionString?: string } = {},
): AutomationFolderStore {
  const client =
    options.client ??
    createDatabaseClient(
      options.connectionString !== undefined ? { connectionString: options.connectionString } : {},
    );
  const ownsClient = options.client === undefined;
  return {
    async close() {
      if (ownsClient) await client.close();
    },

    async assignAutomation(automationSlug, folderId) {
      const [automation] = await client.db
        .select({ id: automations.id, projectId: automations.projectId })
        .from(automations)
        .where(automationNamed(automationSlug))
        .limit(1);
      if (automation === undefined) return { status: "automation-not-found" };
      if (folderId !== null) {
        const folder = await client.db
          .select({ id: automationFolders.id })
          .from(automationFolders)
          .where(
            and(
              eq(automationFolders.id, folderId),
              eq(automationFolders.projectId, automation.projectId),
            ),
          )
          .limit(1);
        if (folder.length === 0) return { status: "folder-not-found" };
      }

      // Still in the project the folder was checked against: a move committed meanwhile matches
      // nothing here, so a folder never lands in another project.
      const updated = await client.db
        .update(automations)
        .set({ folderId, updatedAt: new Date() })
        .where(
          and(eq(automations.id, automation.id), eq(automations.projectId, automation.projectId)),
        )
        .returning({ id: automations.id });
      if (updated.length === 0) return { status: "automation-not-found" };
      return { folderId, status: "ok" };
    },

    async createFolder(projectId, name) {
      const normalized = normalizeFolderName(name);
      const [sortRow] = await client.db
        .select({ value: max(automationFolders.sortOrder) })
        .from(automationFolders)
        .where(eq(automationFolders.projectId, projectId));
      const inserted = await client.db
        .insert(automationFolders)
        .values({
          name: normalized.display,
          normalizedName: normalized.key,
          projectId,
          sortOrder: (sortRow?.value ?? -1) + 1,
        })
        .onConflictDoNothing({
          target: [automationFolders.projectId, automationFolders.normalizedName],
        })
        .returning();
      const folder = inserted[0];
      return folder === undefined
        ? { status: "name-conflict" }
        : { folder: mapFolder(folder), status: "ok" };
    },

    async deleteFolder(folderId) {
      const deleted = await client.db
        .delete(automationFolders)
        .where(eq(automationFolders.id, folderId))
        .returning({ id: automationFolders.id });
      return deleted.length > 0;
    },

    async getFolder(folderId) {
      const [row] = await client.db
        .select()
        .from(automationFolders)
        .where(eq(automationFolders.id, folderId));
      return row === undefined ? null : mapFolder(row);
    },

    async listFolders(projectIds) {
      const rows = await client.db
        .select()
        .from(automationFolders)
        .where(
          projectIds === "all" ? undefined : inArray(automationFolders.projectId, [...projectIds]),
        )
        .orderBy(asc(automationFolders.sortOrder), asc(automationFolders.name));
      return rows.map(mapFolder);
    },

    async renameFolder(folderId, name) {
      const normalized = normalizeFolderName(name);
      try {
        const updated = await client.db
          .update(automationFolders)
          .set({
            name: normalized.display,
            normalizedName: normalized.key,
            updatedAt: new Date(),
          })
          .where(eq(automationFolders.id, folderId))
          .returning();
        const folder = updated[0];
        return folder === undefined
          ? { status: "not-found" }
          : { folder: mapFolder(folder), status: "ok" };
      } catch (error) {
        if (causeCode(error) === PG_ERROR.uniqueViolation) return { status: "name-conflict" };
        throw error;
      }
    },
  };
}

export function normalizeFolderName(name: string): {
  readonly display: string;
  readonly key: string;
} {
  const display = name.trim().replace(/\s+/g, " ");
  if (display.length === 0) {
    throw new AutomationFolderValidationError("Folder name is required.");
  }
  if (display.length > 80) {
    throw new AutomationFolderValidationError("Folder name must be 80 characters or fewer.");
  }
  return { display, key: display.toLocaleLowerCase("en-US") };
}

function mapFolder(row: typeof automationFolders.$inferSelect): AutomationFolder {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

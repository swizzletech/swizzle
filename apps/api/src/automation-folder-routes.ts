import { CodedError, DEFAULT_PROJECT_ID } from "@swizzle/db";
import { type AutomationFolderStore, AutomationFolderValidationError } from "@swizzle/db/postgres";
import type {
  AssignAutomationFolderResponse,
  AutomationFolderResponse,
  AutomationFoldersResponse,
  NoContentResponse,
} from "@swizzle/runtime/http-contract";

import type { ApiServer } from "./http-shared.js";
import { objectSchema, text, urlText } from "./request-validation.js";

/**
 * Folders belong to a project. A list shows the folders of every project the caller holds a role
 * in; creating, renaming, deleting and filing need organize (editor) in the folder's project, and
 * an automation goes only into a folder of its own project. The list says, per folder and for a
 * new one, why the caller may not organize there, so the dashboard leaves those controls out.
 */
export function registerAutomationFolderRoutes(app: ApiServer, store: AutomationFolderStore): void {
  const folderNameBody = { schema: { body: objectSchema({ name: text }) } };
  const newFolderBody = { schema: { body: objectSchema({ name: text, project: urlText }) } };
  const folderAssignmentBody = {
    schema: {
      body: objectSchema({ folderId: { format: "uuid", type: ["string", "null"] } }, ["folderId"]),
    },
  };
  const organize = { action: "organize" } as const;
  app.get<{ Reply: AutomationFoldersResponse }>("/automation-folders", async (request) => {
    const folders = await store.listFolders(await request.access.projects());
    return {
      // A folder made without naming a project goes to the default project.
      create: await request.access.refusal(
        { automationId: null, projectId: DEFAULT_PROJECT_ID },
        organize,
      ),
      folders: await Promise.all(
        folders.map(async (folder) => ({
          ...folder,
          refusal: await request.access.refusal(
            { automationId: null, projectId: folder.projectId },
            organize,
          ),
        })),
      ),
    };
  });

  app.post<{ Reply: AutomationFolderResponse }>(
    "/automation-folders",
    newFolderBody,
    async (request, reply) => {
      const body = request.body as { name?: string; project?: string } | undefined;
      const project = await request.access.project(body?.project ?? DEFAULT_PROJECT_ID, {
        action: "organize",
      });
      try {
        const result = await store.createFolder(project.id, body?.name ?? "");
        if (result.status !== "ok") {
          throw new CodedError("FOLDER_NAME_CONFLICT", "A folder with this name already exists.");
        }
        reply.status(201);
        return result.folder;
      } catch (error) {
        return throwFolderValidationError(error);
      }
    },
  );

  app.patch<{ Reply: AutomationFolderResponse }>(
    "/automation-folders/:folderId",
    folderNameBody,
    async (request) => {
      const { folderId } = request.params as { folderId: string };
      const body = request.body as { name?: string } | undefined;
      await request.access.folder(folderId);
      try {
        const result = await store.renameFolder(folderId, body?.name ?? "");
        if (result.status === "not-found") {
          throw new CodedError("FOLDER_NOT_FOUND", `Folder not found: ${folderId}`);
        }
        if (result.status === "name-conflict") {
          throw new CodedError("FOLDER_NAME_CONFLICT", "A folder with this name already exists.");
        }
        if (result.status === "ok") return result.folder;
        throw new Error(`Unexpected folder mutation status: ${result.status}`);
      } catch (error) {
        return throwFolderValidationError(error);
      }
    },
  );

  app.delete<{ Reply: NoContentResponse }>(
    "/automation-folders/:folderId",
    async (request, reply) => {
      const { folderId } = request.params as { folderId: string };
      await request.access.folder(folderId);
      if (!(await store.deleteFolder(folderId))) {
        throw new CodedError("FOLDER_NOT_FOUND", `Folder not found: ${folderId}`);
      }
      return reply.status(204).send();
    },
  );

  app.put<{ Reply: AssignAutomationFolderResponse }>(
    "/automations/:automationName/folder",
    folderAssignmentBody,
    async (request) => {
      const { automationName } = request.params as { automationName: string };
      await request.access.automation(automationName, { action: "organize" });
      const { folderId } = request.body as { folderId: string | null };
      if (folderId !== null) await request.access.folder(folderId);
      const result = await store.assignAutomation(automationName, folderId);
      switch (result.status) {
        case "ok":
          return result;
        case "automation-not-found":
          throw new CodedError("AUTOMATION_NOT_FOUND", `Automation not found: ${automationName}`);
        case "folder-not-found":
          throw new CodedError("FOLDER_NOT_FOUND", `Folder not found: ${folderId}`);
      }
    },
  );
}

function throwFolderValidationError(error: unknown): never {
  if (!(error instanceof AutomationFolderValidationError)) throw error;
  throw new CodedError("FOLDER_NAME_INVALID", error.message);
}

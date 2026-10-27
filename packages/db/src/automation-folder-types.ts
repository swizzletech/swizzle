// The folder record automation-folders.ts stores, apart from it so that the @swizzle/db root names
// it without loading drizzle or pg.

/** A sorting folder inside one project; names are unique per project and folders grant nothing. */
export interface AutomationFolder {
  readonly createdAt: string;
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly sortOrder: number;
  readonly updatedAt: string;
}

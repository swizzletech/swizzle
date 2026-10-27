import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";

import type { DatabaseClient } from "./client.js";
import type { DashboardMermaidDiagram } from "./dashboard-types.js";
import { automationNamed, automations, deployments } from "./schema.js";

export async function getMermaidDiagram(
  client: DatabaseClient,
  automationSlug: string,
  environment: string,
): Promise<DashboardMermaidDiagram | null> {
  const [row] = await client.db
    .select({
      sourceDirectory: deployments.sourceDirectory,
    })
    .from(deployments)
    .innerJoin(automations, eq(deployments.automationId, automations.id))
    .where(
      and(
        automationNamed(automationSlug),
        eq(deployments.environment, environment),
        eq(deployments.status, "active"),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const filePath = path.join(row.sourceDirectory, "flow.mermaid");
  try {
    await access(filePath);
    return {
      automationSlug,
      available: true,
      content: await readFile(filePath, "utf8"),
      environment: environment,
      error: null,
      filePath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        automationSlug,
        available: false,
        content: null,
        environment: environment,
        error: null,
        filePath,
      };
    }

    return {
      automationSlug,
      available: false,
      content: null,
      environment: environment,
      error: error instanceof Error ? error.message : "Failed to read Mermaid diagram.",
      filePath,
    };
  }
}

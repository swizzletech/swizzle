import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertBackupDestinationFree,
  backupPaths,
  createBackupMetadata,
  createConfiguredArtifactStorage,
  publishBackup,
  readBackup,
} from "@swizzle/runtime";
import type { Command } from "commander";

import {
  localCommand,
  type RunHandler,
  requireYes,
  shellWord,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { AgentError, type CliIO, EXIT_CODES, respond, warn } from "./output.js";

const execFileAsync = promisify(execFile);

/**
 * `swizzle backup export | restore`: an operator command on the instance host. It reads
 * DATABASE_URL and the artifact storage settings from the environment and never calls the API.
 */
export function registerBackup(program: Command, io: CliIO, runHandler: RunHandler): void {
  const backup = localCommand(
    program
      .command("backup")
      .description(
        "Export and restore PostgreSQL state plus deployment artifacts (on the instance host)",
      ),
  );
  showsSubcommands(backup);
  withExamples(backup, [
    "swizzle backup export -o ./backups/2026-10-25",
    "swizzle backup restore -i ./backups/2026-10-25 --yes",
  ]);

  const exportCommand = localCommand(
    backup
      .command("export")
      .description("Write a backup with a database dump and artifact storage contents")
      .option(
        "-o, --output-dir <path>",
        "New or empty directory for the backup (default: ./.swizzle-backup-<time>)",
      ),
  );
  withExamples(exportCommand, [
    "swizzle backup export",
    "swizzle backup export -o ./backups/2026-10-25 --json",
  ]);
  exportCommand.action(async (options: { readonly outputDir?: string }) => {
    await runHandler(async () => {
      const backupDirectory = path.resolve(
        options.outputDir ??
          path.join(
            process.cwd(),
            `.swizzle-backup-${new Date().toISOString().replaceAll(":", "-")}`,
          ),
      );
      const database = databaseUrl("export");
      await assertBackupDestinationFree(backupDirectory);
      const storage = createConfiguredArtifactStorage();
      const metadata = createBackupMetadata(storage.backend);

      await mkdir(path.dirname(backupDirectory), { recursive: true });
      const stagingDirectory = await mkdtemp(
        path.join(path.dirname(backupDirectory), `.${path.basename(backupDirectory)}-`),
      );
      try {
        const staged = backupPaths(stagingDirectory);
        await writeFile(staged.databaseDump, "", { mode: 0o600 });
        await runPgDump(database, staged.databaseDump);
        await storage.exportStore(staged.artifactsDirectory);
        await writeFile(staged.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await publishBackup(stagingDirectory, backupDirectory);
      } catch (error) {
        await rm(stagingDirectory, { force: true, recursive: true }).catch(() => {
          warn(
            `Backup staging cleanup failed at ${stagingDirectory}; remove it after confirming no export is running.`,
          );
        });
        throw error;
      }
      const published = backupPaths(backupDirectory);
      respond(
        io,
        {
          backup: {
            directory: backupDirectory,
            createdAt: metadata.createdAt,
            artifactBackend: metadata.artifactBackend,
            databaseDump: published.databaseDump,
            artifacts: published.artifactsDirectory,
            metadata: published.metadataFile,
          },
        },
        [`Run \`swizzle backup restore -i ${shellWord(backupDirectory)} --yes\` to restore it`],
      );
    });
  });

  const restore = localCommand(
    backup
      .command("restore")
      .description("Restore a backup into the configured database and artifact backend")
      .option("-i, --input-dir <path>", "Backup directory to restore (default: .)")
      .option("--yes", "Confirm the restore, which overwrites database state (required)"),
  );
  withExamples(restore, [
    "swizzle backup restore -i ./backups/2026-10-25 --yes",
    "swizzle backup restore --yes --json",
  ]);
  restore.action(async (options: { readonly inputDir?: string; readonly yes?: boolean }) => {
    await runHandler(async () => {
      const backupDirectory = path.resolve(options.inputDir ?? process.cwd());
      requireYes(
        options.yes,
        `swizzle backup restore -i ${shellWord(backupDirectory)}`,
        "a restore overwrites the database and artifact storage with the backup's state.",
      );
      const database = databaseUrl("restore");
      const metadata = await readBackup(backupDirectory);
      const storage = createConfiguredArtifactStorage();
      if (storage.backend !== metadata.artifactBackend) {
        throw new AgentError({
          code: "BACKUP_BACKEND_MISMATCH",
          exitCode: EXIT_CODES.validation,
          hint: `Set SWIZZLE_ARTIFACT_BACKEND=${metadata.artifactBackend} to match the backup, then restore again.`,
          message: `Artifact backend mismatch: backup=${metadata.artifactBackend}, configured=${storage.backend}.`,
        });
      }
      const { artifactsDirectory, databaseDump } = backupPaths(backupDirectory);
      await storage.importStore(artifactsDirectory);
      await runPsqlRestore(database, databaseDump);
      respond(io, {
        restore: {
          directory: backupDirectory,
          state: "restored",
          artifactBackend: metadata.artifactBackend,
          databaseDump,
          artifacts: artifactsDirectory,
        },
      });
    });
  });
}

function databaseUrl(action: "export" | "restore"): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new AgentError({
      code: "DATABASE_URL_REQUIRED",
      exitCode: EXIT_CODES.usage,
      hint: `Export DATABASE_URL, the instance's PostgreSQL URL, then run \`swizzle backup ${action}\` again.`,
      message: `DATABASE_URL must be set for backup ${action}.`,
    });
  }
  return url;
}

async function runPgDump(database: string, outputPath: string): Promise<void> {
  await execFileAsync("pg_dump", [
    "--clean",
    "--dbname",
    database,
    "--file",
    outputPath,
    "--format=plain",
    "--if-exists",
    "--no-owner",
    "--no-privileges",
  ]);
}

async function runPsqlRestore(database: string, inputPath: string): Promise<void> {
  await execFileAsync("psql", ["--dbname", database, "--file", inputPath]);
}

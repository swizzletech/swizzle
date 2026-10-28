import path from "node:path";
import {
  type AutomationDefinition,
  deployAutomation,
  loadAutomationDefinition,
} from "@swizzle/runtime";
import type {
  AutomationDeletePreviewResponse,
  DeleteAutomationResponse as DeleteAutomationResult,
  DeploymentsResponse,
  MoveAutomationResponse as MoveAutomationResult,
  DeploymentResponse as RollbackResult,
} from "@swizzle/runtime/http-contract";

import type { Command } from "commander";

import { apiRequest } from "./api.js";
import {
  packAutomationOrThrow,
  postDeployment,
  postDeploymentCheck,
  resolveAutomationNameOrDie,
  slugify,
} from "./automation-api.js";
import { formatList, formatTriggerSummary, readinessFields } from "./automation-output.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  DEFAULT_API_URL,
  type ExactCommandOptions,
  type RunHandler,
  requireYes,
  withExamples,
} from "./command-support.js";
import { changeRows, deploymentChangesOutput } from "./deployment-output.js";
import { buildUnservedEnvironmentWarning, resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, respond, warn } from "./output.js";

export function registerDeploymentCommands(
  program: Command,
  io: CliIO,
  runHandler: RunHandler,
): void {
  registerApply(program, io, runHandler);
  registerDeployments(program, io, runHandler);
  registerRollback(program, io, runHandler);
  registerDelete(program, io, runHandler);
  registerMove(program, io, runHandler);
}

type TargetOptions = ApiCommandOptions & ExactCommandOptions;

const DEPENDENCY_NOTE = "dependencies install before the first run and are reused afterwards";

function registerApply(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("apply")
    .description(
      "Deploy an automation directory; an unchanged one is a no-op. --dry-run shows the diff against the active deployment",
    )
    .argument("[automationDir]", "Path to an automation directory (default: .)")
    .option(
      "--dry-run",
      "Compute the diff without registering a new deployment; the API runs every check apply makes and fails with the error apply would give",
    )
    .option("-a, --artifacts-dir <path>", "Directory for local deployment artifacts")
    .option("--local-only", "Only create local artifact, do not register with the platform API")
    .option(
      "--project <project>",
      "Project a new automation joins, by slug or id (default: the profile's, else the default project); an existing one stays in its own",
    )
    .option(
      "--force",
      "Create a new deployment even when unchanged; also skips worker readiness check",
    );
  withExamples(command, [
    "swizzle apply ./hello-webhook",
    "swizzle apply ./hello-webhook --dry-run -e production",
    "swizzle apply ./hello-webhook --project billing",
  ]);
  command.action(runApply(io, runHandler));
}

type ApplyActionOptions = {
  readonly artifactsDir?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly localOnly?: boolean;
  readonly project?: string;
} & ApiCommandOptions;

function runApply(
  io: CliIO,
  runHandler: RunHandler,
): (automationDir: string | undefined, options: ApplyActionOptions) => Promise<void> {
  return async (automationDir, inputOptions) => {
    const dir = automationDir ?? ".";
    await runHandler(async () => {
      const definition = await loadAutomationDefinition(dir);
      const note = hasDeclaredDependencies(definition) ? { note: DEPENDENCY_NOTE } : {};

      // `--local-only` builds the artifact on disk and never calls the API.
      if (inputOptions.localOnly === true) {
        const deployment = await deployAutomation({
          automationDirectory: path.resolve(dir),
          ...(inputOptions.artifactsDir !== undefined
            ? { artifactsDirectory: inputOptions.artifactsDir }
            : {}),
        });
        respond(io, {
          deployment: {
            name: deployment.definition.config.name,
            version: deployment.definition.config.version,
            id: deployment.deploymentId,
            registered: false,
            readiness: deployment.readiness.status,
            build: deployment.buildSnapshot.status,
            runtime: `${deployment.runtimeSnapshot.language} / sandbox (container) / ${deployment.runtimeSnapshot.profile}`,
            sourceHash: deployment.sourceHash,
            artifactRoot: deployment.artifactRootPath,
            manifest: deployment.manifestPath,
          },
          ...note,
        });
        return;
      }

      const options = {
        ...inputOptions,
        environment: await resolveCommandEnvironment(inputOptions, (environment, environments) => {
          if (definition.config.trigger.type !== "cron" || inputOptions.dryRun) return;
          const warning = buildUnservedEnvironmentWarning({
            mode: "deploy",
            environment,
            environments,
          });
          if (warning !== null) warn(warning);
        }),
      };

      const trigger = definition.config.trigger;
      const profileUrl = options.apiUrl ?? DEFAULT_API_URL;

      const packed = await packAutomationOrThrow(path.resolve(dir));

      const request = {
        apiUrl: profileUrl,
        environment: options.environment,
        ...(options.force === true ? { force: true } : {}),
        project: options.project,
      };
      if (options.dryRun) {
        const check = await postDeploymentCheck(packed, request);
        respond(
          io,
          {
            dryRun: true,
            name: definition.config.name,
            environment: options.environment,
            action: check.action,
            ...readinessFields(check.readiness, "the target's workers"),
            ...(check.action === "create"
              ? {
                  version: definition.config.version,
                  entrypoint: definition.config.entrypoint,
                  trigger: formatTriggerSummary(trigger),
                  secrets: formatList(definition.config.secrets),
                  vars:
                    Object.keys(definition.config.vars).length > 0
                      ? definition.config.vars
                      : "none",
                }
              : {
                  changes: deploymentChangesOutput(
                    check.action,
                    check.changes,
                    options.force === true,
                  ),
                }),
            ...(check.webhookUrl === null ? {} : { webhookUrl: check.webhookUrl }),
          },
          [
            check.action === "noop"
              ? `Run \`swizzle apply ${dir} -e ${options.environment} --force\` to deploy it again anyway`
              : `Run \`swizzle apply ${dir} -e ${options.environment}${options.force === true ? " --force" : ""}\` to deploy it`,
          ],
        );
        return;
      }

      const result = await postDeployment(packed, request);
      for (const warning of result.warnings) warn(warning);

      const action = result.action;
      const name = slugify(result.automationName);
      respond(
        io,
        {
          deployment: {
            name: result.automationName,
            environment: options.environment,
            action: action === "noop" ? "noop (already deployed)" : action,
            seq: result.seq,
            version: result.version,
            id: result.deploymentId,
            readiness: result.readiness.status,
            deployedAt: result.deployedAt,
          },
          ...(action === "update" ? { changes: changeRows(result.changes) } : {}),
          ...(result.webhookUrl === null ? {} : { webhookUrl: result.webhookUrl }),
          ...note,
        },
        result.readiness.status === "ready"
          ? applyNextSteps(trigger.type, name, options.environment)
          : [
              `Run \`swizzle inspect ${name} -e ${options.environment}\` to see what it still needs`,
            ],
      );
    });
  };
}

function applyNextSteps(triggerType: string, name: string, environment: string): string[] {
  return [
    ...(triggerType === "chain"
      ? []
      : [`Run \`swizzle trigger ${name} -e ${environment}\` to start a run`]),
    `Run \`swizzle inspect ${name} -e ${environment}\` for its trigger, secrets and recent runs`,
  ];
}

function hasDeclaredDependencies(definition: AutomationDefinition): boolean {
  return (
    definition.config.runtime.requirements.python !== undefined ||
    definition.config.runtime.requirements.node !== undefined
  );
}

function registerDeployments(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("deployments")
    .description("List an automation's deployments, newest first, to pick a rollback target")
    .argument("[automationName]", "Automation name (default: detected from cwd)")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(command, [
    "swizzle deployments hello-webhook",
    "swizzle deployments hello-webhook -e production --json",
  ]);
  command.action(async (automationName: string | undefined, inputOptions: TargetOptions) => {
    await runHandler(async () => {
      const options = {
        ...inputOptions,
        environment: await resolveCommandEnvironment(inputOptions),
      };
      const resolved = await resolveAutomationNameOrDie(automationName, options);
      const response = await apiRequest<DeploymentsResponse>(
        buildApiUrl(`/automations/${resolved.slug}/deployments`, options),
      );
      const deployments = response.deployments.map((deployment) => ({
        seq: deployment.seq,
        version: deployment.version,
        status: deployment.status,
        deployedAt: deployment.deployedAt,
        id: deployment.deploymentId,
      }));
      respond(
        io,
        {
          automation: resolved.slug,
          environment: response.environment,
          count: deployments.length,
          deployments,
        },
        deployments.length === 0
          ? [`Run \`swizzle apply <dir> -e ${response.environment}\` to deploy it`]
          : [
              `Run \`swizzle rollback ${resolved.slug} <seq> -e ${response.environment}\` to switch back to an earlier one`,
            ],
      );
    });
  });
}

function registerRollback(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("rollback")
    .description("Make an earlier deployment of an automation the active one")
    .argument("<automationName>", "Automation name")
    .argument("<deployment>", "Deployment number (#3 or 3) or deployment id")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(command, [
    "swizzle rollback hello-webhook 3",
    "swizzle rollback hello-webhook dep_01J9 -e production",
  ]);
  command.action(
    async (automationName: string, deployment: string, inputOptions: TargetOptions) => {
      await runHandler(async () => {
        const options = {
          ...inputOptions,
          environment: await resolveCommandEnvironment(inputOptions),
        };
        const resolved = await resolveAutomationNameOrDie(automationName, options, {
          destructive: true,
        });
        const targetDeploymentId = await resolveDeploymentTargetId(
          resolved.slug,
          deployment,
          options,
        );
        const result = await apiRequest<RollbackResult>(
          buildApiUrl(`/automations/${resolved.slug}/rollback`, options),
          {
            body: JSON.stringify({ targetDeploymentId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        respond(io, {
          automation: resolved.slug,
          environment: options.environment,
          active: {
            seq: result.seq,
            version: result.version,
            id: result.deploymentId,
            deployedAt: result.deployedAt,
          },
        });
      });
    },
  );
}

function registerDelete(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("delete")
    .description(
      "Delete an automation with its deployments, triggers, state, artifacts and runs. Names dependent chains before confirmation; their triggers become invalid. Its audit events stay. Pause the trigger and let runs finish first",
    )
    .argument("<automationName>", "Automation name")
    .option("--yes", "Confirm the delete (required)")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(command, [
    "swizzle delete hello-webhook --yes",
    "swizzle delete hello-webhook -e production --yes",
  ]);
  command.action(
    async (automationName: string, inputOptions: TargetOptions & { readonly yes?: boolean }) => {
      await runHandler(async () => {
        const options = {
          ...inputOptions,
          environment: await resolveCommandEnvironment(inputOptions),
        };
        const resolved = await resolveAutomationNameOrDie(automationName, options, {
          destructive: true,
        });
        const impact = await apiRequest<AutomationDeletePreviewResponse>(
          buildApiUrl(`/automations/${resolved.slug}/delete-preview`, options),
        ).catch((error: unknown) => {
          if (error instanceof AgentError && error.code === "AUTOMATION_NOT_FOUND") return null;
          if (error instanceof AgentError && error.details?.httpStatus === 404) {
            throw new AgentError({
              code: "DELETE_PREVIEW_UNAVAILABLE",
              message: "Cannot delete without a preview of the dependent chain triggers.",
              hint: "Upgrade the server to support deletion previews, then rerun the delete command.",
              exitCode: EXIT_CODES.backend,
            });
          }
          throw error;
        });
        const dependents = [
          ...(impact?.dependents ?? []).map(
            (entry) => `${entry.automationSlug} (${entry.environment})`,
          ),
          ...((impact?.hiddenDependents ?? 0) === 0
            ? []
            : [`${impact?.hiddenDependents} dependent chain triggers you cannot see`]),
        ];
        const chainWarning =
          dependents.length === 0
            ? null
            : `Chain source ${resolved.slug} will be deleted; these dependent automations will have invalid chain triggers: ${dependents.join(", ")}.`;
        requireYes(
          options.yes,
          `swizzle delete ${resolved.slug} -e ${options.environment}`,
          `this deletes ${resolved.slug} in every environment with its deployments, triggers, state, artifacts and runs; only its audit events stay.${chainWarning === null ? "" : ` ${chainWarning}`}`,
        );
        if (chainWarning !== null) warn(chainWarning);

        const result =
          impact === null
            ? undefined
            : await apiRequest<DeleteAutomationResult | undefined>(
                buildApiUrl(`/automations/${resolved.slug}`, options),
                { acceptNotFound: true, method: "DELETE" },
              );
        if (result === undefined) {
          respond(io, {
            automation: resolved.slug,
            environment: options.environment,
            state: "already absent (no-op)",
          });
          return;
        }
        respond(io, {
          automation: result.automationSlug,
          environment: result.environment,
          state: "deleted",
          deleted: {
            deployments: result.deletedCounts.deployments,
            runs: result.deletedCounts.runs,
          },
          keptAuditEvents: result.kept.auditEvents,
          artifactsRemoved: result.artifactsRemoved,
          ...(result.artifactError ? { artifactError: result.artifactError } : {}),
        });
      });
    },
  );
}

function registerMove(program: Command, io: CliIO, runHandler: RunHandler): void {
  const command = program
    .command("move")
    .description(
      "Move an automation to another project. Needs admin in both projects; pause its trigger in every environment first. Its runs and audit events stay in the old project, and its shares and folder are dropped",
    )
    .argument("<automationName>", "Automation name")
    .requiredOption("--project <project>", "Target project, by slug or id")
    .option("--exact", "Disable fuzzy name matching");
  withExamples(command, [
    "swizzle move hello-webhook --project billing",
    "swizzle move invoice-sync --project finance --exact",
  ]);
  command.action(
    async (automationName: string, inputOptions: TargetOptions & { readonly project: string }) => {
      await runHandler(async () => {
        const options = {
          ...inputOptions,
          environment: await resolveCommandEnvironment(inputOptions),
        };
        const resolved = await resolveAutomationNameOrDie(automationName, options, {
          destructive: true,
        });
        const result = await apiRequest<MoveAutomationResult>(
          buildApiUrl(`/automations/${resolved.slug}/project`, options),
          {
            body: JSON.stringify({ project: options.project }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          },
        );
        if (!result.moved) {
          respond(io, {
            automation: result.automationSlug,
            state: `already in project ${options.project} (no-op)`,
          });
          return;
        }
        respond(
          io,
          { automation: result.automationSlug, project: options.project, state: "moved" },
          [
            `Run \`swizzle trigger resume ${result.automationSlug} -e <environment>\` in each environment to start it again`,
          ],
        );
      });
    },
  );
}

async function resolveDeploymentTargetId(
  automationSlug: string,
  target: string,
  options: ApiCommandOptions,
): Promise<string> {
  const seq = parseDeploymentSeq(target);
  if (seq === null) {
    return target;
  }

  const response = await apiRequest<DeploymentsResponse>(
    buildApiUrl(`/automations/${automationSlug}/deployments`, options),
  );
  const deployment = response.deployments.find((entry) => entry.seq === seq);
  if (!deployment) {
    throw new AgentError({
      code: "DEPLOYMENT_NOT_FOUND",
      fixCommand: `swizzle deployments ${automationSlug}`,
      message: `Deployment #${seq} not found for ${automationSlug}.`,
    });
  }

  return deployment.deploymentId;
}

function parseDeploymentSeq(value: string): number | null {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const seq = Number(normalized);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

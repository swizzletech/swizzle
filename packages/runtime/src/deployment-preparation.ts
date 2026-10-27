// Assigned source bundles let a worker prepare run images without database or artifact credentials.
import type { RunImageDisk } from "@swizzle/db";
import { prepareContainerAutomation } from "./container-runner.js";
import { closeDockerScopes, removeAbandonedContainers } from "./docker-cli.js";
import { withExecutionSource } from "./execution-wire.js";
import type { PlatformLogger } from "./platform-types.js";
import {
  pruneRunImages,
  RUN_IMAGE_PRUNE_INTERVAL_MS,
  runImageRecipe,
  runImageTag,
} from "./run-image.js";
import { runsInSandbox } from "./runner.js";
import { closeSandboxes } from "./sandbox.js";
import { parseRuntimeTimeout } from "./timeout-policy.js";
import { loadAutomationDefinition } from "./validation.js";
import type { PreparationBundle, PreparationSnapshot } from "./worker-wire.js";

const POLL_MS = 2_000;
/** A deployment younger than this gets a standby sandbox for its first run. */
const STANDBY_DEPLOYMENT_AGE_MS = 10 * 60 * 1_000;

export interface DeploymentPreparation {
  /** What the last prune pass measured, for the next heartbeat; null before the first pass. */
  runImageDisk(): RunImageDisk | null;
  /** Stops polling, waits for the preparation in progress and removes the standby sandboxes. */
  close(): Promise<void>;
}

/**
 * Prepares assigned deployments once per process and prunes using durable image ownership.
 * Preparation and pruning take turns in one loop, so no tag this process records lands during a
 * pass. `keptImages` returns the tags the server keeps for this worker, read just before each pass.
 */
export function startDeploymentPreparation(input: {
  readonly poll: (knownIds: readonly string[]) => Promise<PreparationSnapshot>;
  readonly recordImage: (deploymentId: string, tag: string) => Promise<void>;
  readonly keptImages: () => Promise<readonly string[]>;
  readonly logger?: PlatformLogger;
}): DeploymentPreparation {
  // A prepared deployment learned its tag (or needs no sandbox). Only failures before tag
  // acknowledgement retry, at the stored time. Image ownership itself lives in Postgres.
  const nextPreparation = new Map<string, number | "prepared">();
  let prunedAt = 0;
  let disk: RunImageDisk | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const prepareNew = async () => {
    await removeAbandonedContainers();
    const snapshot = await input.poll(
      [...nextPreparation]
        .filter(([, at]) => at === "prepared" || at > Date.now())
        .map(([id]) => id),
    );
    const activeIds = new Set(snapshot.activeIds);
    let changed = false;
    for (const id of nextPreparation.keys()) {
      if (activeIds.has(id)) continue;
      nextPreparation.delete(id);
      changed = true;
    }
    for (const deployment of snapshot.deployments) {
      if (stopped) return;
      const next = nextPreparation.get(deployment.deploymentId);
      if (next === "prepared" || (next !== undefined && next > Date.now())) continue;
      const startedAt = Date.now();
      nextPreparation.set(deployment.deploymentId, startedAt + RUN_IMAGE_PRUNE_INTERVAL_MS);
      try {
        const prepared = await prepare(deployment, async (tag) => {
          await input.recordImage(deployment.deploymentId, tag);
          nextPreparation.set(deployment.deploymentId, "prepared");
        });
        nextPreparation.set(deployment.deploymentId, "prepared");
        changed = true;
        if (prepared)
          input.logger?.info(
            {
              automationName: deployment.automationName,
              deploymentId: deployment.deploymentId,
              durationMs: Date.now() - startedAt,
            },
            "Prepared deployment.",
          );
      } catch (error) {
        input.logger?.warn(
          {
            automationName: deployment.automationName,
            deploymentId: deployment.deploymentId,
            err: error,
          },
          "Deployment preparation failed; its first run prepares it.",
        );
      }
    }
    const complete = [...activeIds].every((id) => nextPreparation.get(id) === "prepared");
    if (complete && (changed || Date.now() - prunedAt >= RUN_IMAGE_PRUNE_INTERVAL_MS)) {
      const pass = await pruneRunImages({
        keep: new Set(await input.keptImages()),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      if (pass.removed > 0) input.logger?.info({ removed: pass.removed }, "Pruned run images.");
      disk = pass.disk;
      prunedAt = Date.now();
    }
  };

  let current = Promise.resolve();
  const poll = () => {
    current = prepareNew()
      .catch((error: unknown) => {
        input.logger?.warn({ err: error }, "Preparing or pruning deployments failed.");
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(poll, POLL_MS);
      });
  };
  poll();

  return {
    runImageDisk: () => disk,
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      await closeDockerScopes();
      await current;
      await closeSandboxes();
    },
  };
}

/**
 * Prepares one deployment, and hands `onRunImage` its run image tag before the image is assembled,
 * so a failed preparation still keeps the image the first run assembles. Resolves false when its
 * runs do not use a sandbox.
 */
async function prepare(
  deployment: PreparationBundle,
  onRunImage: (tag: string) => Promise<void>,
): Promise<boolean> {
  return await withExecutionSource(deployment.files, async (directory) => {
    const definition = await loadAutomationDefinition(directory);
    if (!runsInSandbox(definition, true)) return false;
    await onRunImage(await runImageTag(definition.directory, runImageRecipe(definition)));
    await prepareContainerAutomation({
      automationDirectory: definition.directory,
      definition,
      standby: Date.now() - Date.parse(deployment.deployedAt) < STANDBY_DEPLOYMENT_AGE_MS,
      timeoutMs: parseRuntimeTimeout(definition.config.runtime.timeout),
    });
    return true;
  });
}

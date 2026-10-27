// The sentences about workers that more than one surface shows: why a queued run waits for one,
// why it failed to find one, and a worker's run image disk. `swizzle diagnose`, the run panel, the
// Overview's Needs you, Settings > Workers and `swizzle worker list` all print these, so the CLI
// and the dashboard say the same thing.

import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import type {
  PlacementFix,
  PlacementWords,
  RunImageDisk,
  RunPlacement,
  WorkerWarning,
} from "./workers.js";

/** Why a queued run has not started and what gets it going. */
export function placementInWords(
  placement: RunPlacement,
  target: { readonly projectId?: string | undefined; readonly environment?: string | undefined },
): PlacementWords {
  const group = `group "${placement.group}"`;
  const llm = placement.services.includes(LOCAL_LLM_SERVICE);
  const reason = {
    "no-worker": `No worker is granted ${group}${llm ? ` and ${LOCAL_LLM_SERVICE}` : ""} for this project and environment.`,
    offline: `Every worker granted ${group} is offline, draining or not enrolled yet; the run starts when one comes online.`,
    "service-unhealthy": `The online workers in ${group} do not report ${LOCAL_LLM_SERVICE} healthy.`,
    busy: `Every worker in ${group} that could take the run has all its slots in use; it starts when one finishes.`,
    ready: `A worker in ${group} has a free slot; the run starts on its next pull, after any retry delay or rate limit.`,
  }[placement.wait];
  return {
    reason,
    summary: `${reason} If no worker takes it within its queue_timeout of ${placement.queueTimeout}, the run fails; it never runs in another group.`,
    fixes: placementFixes(placement, target),
  };
}

function placementFixes(
  placement: RunPlacement,
  target: { readonly projectId?: string | undefined; readonly environment?: string | undefined },
): readonly PlacementFix[] {
  const llm = placement.services.includes(LOCAL_LLM_SERVICE);
  switch (placement.wait) {
    case "no-worker":
      return [
        {
          command: "swizzle worker groups",
          confidence: 0.9,
          rationale:
            "List the groups that serve this project, then set runtime.profile in config.yaml to one of them and apply.",
        },
        {
          command: `swizzle worker create <name> --project ${target.projectId ?? "<project>"} --environment ${target.environment ?? "<environment>"} --groups ${placement.group}${llm ? " --local-llm" : ""}`,
          confidence: 0.6,
          rationale: `Or an owner or admin grants a machine group "${placement.group}"${llm ? " and local LLM inference, which this run requests" : ""} under Settings > Workers.`,
        },
      ];
    case "offline":
      return [
        {
          confidence: 0.85,
          rationale:
            "Start or wake a worker machine of the group, or finish its enrollment; its stack resumes pulling by itself. Settings > Workers shows when each was last seen.",
        },
      ];
    case "service-unhealthy":
      return [
        {
          confidence: 0.8,
          rationale:
            "Check the model server on the worker host: the worker reports local-llm in its heartbeat, and only a healthy one takes runs that request it.",
        },
      ];
    case "busy":
      return [
        {
          confidence: 0.5,
          rationale:
            "Wait for a running attempt to finish, or enroll another worker in the group for more capacity.",
        },
      ];
    case "ready":
      return [];
  }
}

/**
 * Why a run found no worker within its queue timeout, naming its project and how an owner or
 * admin grants it a worker.
 */
export function unservedProjectMessage(input: {
  readonly project: { readonly id: string; readonly name: string };
  readonly environment: string;
  readonly profile: string;
  readonly within: string;
}): string {
  return `No live worker served project "${input.project.name}" in ${input.environment} for group "${input.profile}" within ${input.within}. An owner or admin grants a worker under Settings > Workers, or with swizzle worker create <name> --project ${input.project.id} --environment ${input.environment} --groups ${input.profile}.`;
}

/** The warning for active images whose measured bytes exceed the budget or whose usage is unknown. */
export function runImageDiskWarning(worker: string, disk: RunImageDisk): WorkerWarning {
  if (disk.unmeasuredActiveImages.length > 0 || disk.unmeasuredActiveImagesOmitted > 0) {
    const images = [
      ...disk.unmeasuredActiveImages.map(({ id, tags }) =>
        tags.length === 0 ? id : `${id} (${tags.join(", ")})`,
      ),
      ...(disk.unmeasuredActiveImagesOmitted > 0
        ? [`${disk.unmeasuredActiveImagesOmitted} more unmeasured active images`]
        : []),
    ].join(", ");
    return {
      title: `${worker} keeps unmeasured run images for active deployments: ${images}. Their disk usage is unknown. Swizzle keeps them so those deployments keep running.`,
      todo: "Check this worker's Docker image history and prune logs, or remove the deployments that use these images.",
    };
  }
  return {
    title: `${worker} keeps ${bytesInWords(disk.activeBytes)} of run images for active deployments, more than its disk budget of ${bytesInWords(disk.budgetBytes)}. Swizzle keeps them so those deployments keep running.`,
    todo: "Remove deployments this worker runs, or raise SWIZZLE_RUNNER_IMAGE_DISK_MB on it and restart it.",
  };
}

/** "512 MiB" or "3.3 GiB". */
function bytesInWords(bytes: number): string {
  const mib = bytes / 1_048_576;
  return mib < 1024 ? `${Math.ceil(mib)} MiB` : `${(mib / 1024).toFixed(1)} GiB`;
}

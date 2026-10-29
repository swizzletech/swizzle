import {
  type AutomationRuntimeConfig,
  LOCAL_LLM_SERVICE,
  type WorkerService,
} from "@swizzle/config";
import type { AuditEventOf } from "./audit.js";

/** Worker identity and grants, shared by enrollment, the HTTP guard, and server dispatch. */
export interface WorkerEnvironment {
  readonly projectId: string;
  readonly environment: string;
}

/** What an owner grants an enrolled machine. */
export interface WorkerGrants {
  readonly profiles: readonly string[];
  readonly services: readonly WorkerService[];
  readonly environments: readonly WorkerEnvironment[];
}

/**
 * Where a worker may run work. The stack's local worker reaches every project and environment of
 * the instance, including ones created later; an enrolled machine reaches only its grants.
 */
export type WorkerReach = "all" | readonly WorkerEnvironment[];

/** The local row stores no grants: its reach comes from being the stack's own machine. */
export function workerReach(row: {
  readonly local: boolean;
  readonly environments: readonly WorkerEnvironment[];
}): WorkerReach {
  return row.local ? "all" : row.environments;
}

/** Whether a worker serves any project of an environment, as deploy readiness lists machines. */
export function workerReachesEnvironment(reach: WorkerReach, environment: string): boolean {
  return reach === "all" || reach.some((grant) => grant.environment === environment);
}

export function workerReaches(reach: WorkerReach, target: WorkerEnvironment): boolean {
  return (
    reach === "all" ||
    reach.some(
      (grant) => grant.projectId === target.projectId && grant.environment === target.environment,
    )
  );
}

/** Keep worker heartbeats and warnings bounded regardless of the Docker inventory size. */
export const RUN_IMAGE_DISK_DETAILS_LIMIT = 8;

/**
 * What a worker's last image prune pass measured on its Docker engine, as its next heartbeat
 * reported it. Images of active deployments are always kept (ADR 0006), so `activeBytes` can pass
 * `budgetBytes`. Unmeasured active images also warn the owner; nothing is refused.
 */
export interface RunImageDisk {
  /** Measured bytes of active images; excludes unmeasuredActiveImages. */
  readonly activeBytes: number;
  /** Additional unmeasured images whose details are omitted from this report. */
  readonly unmeasuredActiveImagesOmitted: number;
  /** Details for at most RUN_IMAGE_DISK_DETAILS_LIMIT images, with one active run tag each. */
  readonly unmeasuredActiveImages: readonly {
    readonly id: string;
    readonly tags: readonly string[];
  }[];
  /** The worker's SWIZZLE_RUNNER_IMAGE_DISK_MB in bytes. */
  readonly budgetBytes: number;
}

/**
 * The measurement the owner is warned about, wherever workers show: Settings > Workers, the
 * Overview and `swizzle worker list`, which print `runImageDiskWarning`. Null when all active images
 * are measured within budget, before the first pass, and for revoked workers.
 */
export function runImageDiskOverBudget(
  worker: Pick<RegisteredWorker, "runImageDisk" | "state">,
): RunImageDisk | null {
  const disk = worker.runImageDisk;
  return disk !== null &&
    worker.state !== "revoked" &&
    (disk.activeBytes > disk.budgetBytes ||
      disk.unmeasuredActiveImages.length > 0 ||
      disk.unmeasuredActiveImagesOmitted > 0)
    ? disk
    : null;
}

/** A language or binary a worker found on its host, with the version it reported. */
interface WorkerTool<Name extends string> {
  readonly name: Name;
  readonly version: string | null;
}

/**
 * What a worker's host can run, as its last heartbeat measured it. Deploy readiness compares an
 * automation's runtime block against it; placement does not read it.
 */
export interface WorkerCapabilities {
  readonly languages: readonly WorkerTool<AutomationRuntimeConfig["language"]>[];
  readonly binaries: readonly WorkerTool<string>[];
  readonly executionModes: readonly AutomationRuntimeConfig["execution_mode"][];
  /** Whether the host can install declared Node or Python dependencies. */
  readonly dependencyPackaging: { readonly node: boolean; readonly python: boolean };
}

export interface RegisteredWorker {
  readonly profiles: readonly string[];
  readonly services: readonly WorkerService[];
  readonly environments: WorkerReach;
  readonly kind: "local" | "remote";
  readonly capacity: number;
  readonly draining: boolean;
  readonly id: string;
  readonly credentialGeneration: number;
  readonly name: string;
  readonly state: "pending" | "online" | "offline" | "revoked";
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly tokenExpiresAt: string | null;
  /** Null until a heartbeat reports the worker's first image prune pass. */
  readonly runImageDisk: RunImageDisk | null;
  /** Null until the worker's first heartbeat. */
  readonly capabilities: WorkerCapabilities | null;
}

/** A run a worker holds a live lease for. */
export interface WorkerRun {
  readonly runId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly projectId: string;
  readonly environment: string;
  readonly startedAt: string | null;
}

/** What a worker reports of a service it runs. */
export type ReportedServiceHealth = "healthy" | "unhealthy" | "disabled";
/** A worker's last report per service, kept on its row with the time it arrived. */
export type ServiceHealthReport = Readonly<Partial<Record<WorkerService, ReportedServiceHealth>>>;
/** What a worker's heartbeat reports of its host. */
export interface WorkerReport {
  readonly capabilities: WorkerCapabilities;
  readonly services: ServiceHealthReport;
  readonly runImageDisk: RunImageDisk | null;
}
/** The local LLM service's health from the worker's last heartbeat within a minute, else null. */
export type ServiceHealth = ReportedServiceHealth | null;

/** A worker as Settings > Workers and `swizzle worker list` show it. */
export interface WorkerStatus extends RegisteredWorker {
  /** Live leases, runs and API checks alike, against `capacity`. */
  readonly slotsInUse: number;
  readonly currentRuns: readonly WorkerRun[];
  readonly localLlm: ServiceHealth;
  /** `runImageDisk` while it warns the owner, else null; see `runImageDiskOverBudget`. */
  readonly runImageDiskOverBudget: RunImageDisk | null;
}

/** A warning as every surface prints it: what is wrong, then what the owner does about it. */
export interface WorkerWarning {
  readonly title: string;
  readonly todo: string;
}

/** A worker as `GET /workers` returns it, with the disk warning the runtime words. */
export interface WorkerListing extends WorkerStatus {
  /** Null while `runImageDiskOverBudget` is. */
  readonly runImageDiskWarning: WorkerWarning | null;
}

/**
 * What a project member may learn about a machine that serves their project: no id, host,
 * address or credential, so discovery reveals nothing an automation could reach directly.
 */
export type WorkerSummary = Pick<
  WorkerStatus,
  "name" | "kind" | "state" | "draining" | "lastSeenAt" | "services" | "localLlm"
>;

/** A `runtime.profile` value and the machines granted it for one project and environment. */
export interface WorkerGroup {
  readonly name: string;
  readonly workers: readonly WorkerSummary[];
}

/**
 * Why a queued run has not started, by `workerFit`, the rule claims follow:
 * - `no-worker`: no unrevoked worker is granted its group, project, environment and services.
 * - `offline`: granted workers exist, none is online and accepting work.
 * - `service-unhealthy`: accepting workers do not report the requested service healthy.
 * - `busy`: every accepting worker with the service healthy has all its slots in use.
 * - `ready`: a worker has a free slot; the run starts on its next pull, after any retry delay or
 *   rate limit.
 */
export type PlacementWait = "no-worker" | "offline" | "service-unhealthy" | "busy" | "ready";

/** A granted machine and why it does not take the run now, or `ready` when it can. */
interface PlacedWorker extends WorkerSummary {
  readonly wait: Exclude<PlacementWait, "no-worker">;
}

export interface RunPlacement {
  readonly group: string;
  /** The services the run requests; a worker needs each granted. */
  readonly services: readonly WorkerService[];
  /** The closest any granted worker is to taking the run. */
  readonly wait: PlacementWait;
  /** When the run fails with PLACEMENT_TIMEOUT if no worker has taken it. */
  readonly deadline: string;
  readonly queueTimeout: string;
  /** The workers granted the run's group, project, environment and services. */
  readonly workers: readonly PlacedWorker[];
}

/** A next step for the owner, with the command that takes it when there is one. */
export interface PlacementFix {
  readonly command?: string;
  readonly confidence: number;
  readonly rationale: string;
}

/** Why a queued run has not started and what gets it going, as every surface prints it. */
export interface PlacementWords {
  /** The wait in one sentence. */
  readonly reason: string;
  /** `reason` and what happens at the deadline, which each surface prints in its own clock. */
  readonly summary: string;
  readonly fixes: readonly PlacementFix[];
}

/** A queued run's placement as the run read model returns it, with the words the runtime gives it. */
export interface ExplainedPlacement extends RunPlacement {
  readonly words: PlacementWords;
}

/** What placement reads of a run. */
export interface PlacementTarget extends WorkerEnvironment {
  readonly profile: string;
  readonly services: readonly WorkerService[];
}

/**
 * How close a worker is to taking work of a group, project, environment and services, farthest
 * first. Every placement decision reads this one ladder: a claim takes work only when it is
 * `ready`, pull offers only such work, placement explains every worker granted the services, and
 * deploy readiness counts every worker granted the group.
 */
const WORKER_FITS = [
  "no-group",
  "no-service",
  "offline",
  "service-unhealthy",
  "busy",
  "ready",
] as const;
export type WorkerFit = (typeof WORKER_FITS)[number];

/** What placement reads of a worker: its grants, liveness, slots and reported service health. */
export type PlacementWorker = Pick<
  WorkerStatus,
  | "state"
  | "draining"
  | "profiles"
  | "services"
  | "environments"
  | "capacity"
  | "slotsInUse"
  | "localLlm"
>;

export function workerFit(worker: PlacementWorker, target: PlacementTarget): WorkerFit {
  if (
    worker.state === "revoked" ||
    !worker.profiles.includes(target.profile) ||
    !workerReaches(worker.environments, target)
  )
    return "no-group";
  if (!target.services.every((service) => worker.services.includes(service))) return "no-service";
  if (worker.state !== "online" || worker.draining) return "offline";
  if (target.services.includes(LOCAL_LLM_SERVICE) && worker.localLlm !== "healthy")
    return "service-unhealthy";
  return worker.slotsInUse >= worker.capacity ? "busy" : "ready";
}

function summary(worker: WorkerStatus): WorkerSummary {
  const { name, kind, state, draining, lastSeenAt, services, localLlm } = worker;
  return { name, kind, state, draining, lastSeenAt, services, localLlm };
}

/** Closest to a claim first: the run's wait is the first of these any granted worker reaches. */
const WORKER_WAITS = ["ready", "busy", "service-unhealthy", "offline"] as const;

export function explainPlacement(
  target: PlacementTarget & { readonly deadline: Date; readonly queueTimeout: string },
  workers: readonly WorkerStatus[],
): RunPlacement {
  const eligible = workers.flatMap((worker): PlacedWorker[] => {
    const fit = workerFit(worker, target);
    return fit === "no-group" || fit === "no-service" ? [] : [{ ...summary(worker), wait: fit }];
  });
  return {
    group: target.profile,
    services: target.services,
    wait:
      WORKER_WAITS.find((wait) => eligible.some((worker) => worker.wait === wait)) ?? "no-worker",
    deadline: target.deadline.toISOString(),
    queueTimeout: target.queueTimeout,
    workers: eligible,
  };
}

/** The groups that serve a project and environment, for an agent choosing `runtime.profile`. */
export function workerGroups(
  target: WorkerEnvironment,
  workers: readonly WorkerStatus[],
): readonly WorkerGroup[] {
  const groups = new Map<string, WorkerSummary[]>();
  for (const worker of workers) {
    if (worker.state === "revoked" || !workerReaches(worker.environments, target)) continue;
    for (const name of worker.profiles)
      groups.set(name, [...(groups.get(name) ?? []), summary(worker)]);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, members]) => ({ name, workers: members }));
}

export interface WorkerEnrollment {
  readonly worker: RegisteredWorker;
  /** Returned once. Only the hash is persisted. */
  readonly code: string;
  readonly expiresAt: string;
}

export interface WorkerCredential {
  readonly worker: RegisteredWorker;
  /** Returned once. Never exposed through list or session responses. */
  readonly token: string;
}

export interface WorkerRegistry {
  create(
    input: WorkerGrants & {
      readonly name: string;
      readonly issuedBy: string | null;
      readonly capacity?: number;
    },
  ): Promise<WorkerEnrollment>;
  enroll(code: string, clientKey: string): Promise<WorkerCredential>;
  list(): Promise<readonly WorkerStatus[]>;
  /** Why a queued run waits and until when; read from the run's row and the live workers. */
  placement(
    run: PlacementTarget & { readonly runId: string; readonly queueTimeout: string },
  ): Promise<RunPlacement>;
  revoke(id: string, issuedBy: string | null): Promise<RegisteredWorker>;
  /** Resolve a verified worker token to its current worker identity without locking or writing. */
  authenticate(workerId: string, tokenId: string): Promise<RegisteredWorker>;
  /** Rechecks identity and scope under the same lock as heartbeat or token renewal. */
  session(
    identity: WorkerIdentity,
    target: WorkerEnvironment & { readonly profile: string },
  ): Promise<RegisteredWorker>;
  /**
   * Marks the worker seen; with a report, also stores its capabilities, service health and image
   * disk. Returns the worker as placement sees it now.
   */
  heartbeat(
    identity: WorkerIdentity,
    report?: WorkerReport,
  ): Promise<RegisteredWorker & PlacementWorker>;
  drain(identity: WorkerIdentity, draining: boolean): Promise<void>;
  renew(identity: WorkerIdentity, nextToken: string): Promise<WorkerCredential>;
  audit(id: string): Promise<readonly AuditEventOf<"worker">[]>;
  close(): Promise<void>;
}

export type WorkerIdentity = Pick<RegisteredWorker, "id" | "credentialGeneration">;

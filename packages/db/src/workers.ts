import {
  type AutomationRuntimeConfig,
  LOCAL_LLM_SERVICE,
  type WorkerService,
} from "@swizzle/config";
import type { AuditEventOf } from "./audit.js";

export interface WorkerEnvironment {
  readonly projectId: string;
  readonly environment: string;
}

export interface WorkerGrants {
  readonly profiles: readonly string[];
  readonly services: readonly WorkerService[];
  readonly environments: readonly WorkerEnvironment[];
}

export type WorkerReach = "all" | readonly WorkerEnvironment[];

export function workerReach(row: {
  readonly local: boolean;
  readonly environments: readonly WorkerEnvironment[];
}): WorkerReach {
  return row.local ? "all" : row.environments;
}

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

export const RUN_IMAGE_DISK_DETAILS_LIMIT = 8;

export interface RunImageDisk {
  readonly activeBytes: number;
  readonly budgetBytes: number;
  readonly unmeasured: {
    readonly images: readonly { readonly id: string; readonly tag: string | null }[];
    readonly total: number;
  };
}

export type RunImageDiskProblem = "over-budget" | "unmeasured";

export function runImageDiskProblems(disk: RunImageDisk): readonly RunImageDiskProblem[] {
  const problems: RunImageDiskProblem[] = [];
  if (disk.activeBytes > disk.budgetBytes) problems.push("over-budget");
  if (disk.unmeasured.total > 0) problems.push("unmeasured");
  return problems;
}

export function runImageDiskOverBudget(
  worker: Pick<RegisteredWorker, "runImageDisk" | "state">,
): RunImageDisk | null {
  const disk = worker.runImageDisk;
  return disk !== null && worker.state !== "revoked" && runImageDiskProblems(disk).length > 0
    ? disk
    : null;
}

interface WorkerTool<Name extends string> {
  readonly name: Name;
  readonly version: string | null;
}

export interface WorkerCapabilities {
  readonly languages: readonly WorkerTool<AutomationRuntimeConfig["language"]>[];
  readonly binaries: readonly WorkerTool<string>[];
  readonly executionModes: readonly AutomationRuntimeConfig["execution_mode"][];
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
  readonly runImageDisk: RunImageDisk | null;
  readonly capabilities: WorkerCapabilities | null;
}

export interface WorkerRun {
  readonly runId: string;
  readonly automationName: string;
  readonly automationSlug: string;
  readonly projectId: string;
  readonly environment: string;
  readonly startedAt: string | null;
}

export type ReportedServiceHealth = "healthy" | "unhealthy" | "disabled";
export type ServiceHealthReport = Readonly<Partial<Record<WorkerService, ReportedServiceHealth>>>;
export interface WorkerReport {
  readonly capabilities: WorkerCapabilities;
  readonly services: ServiceHealthReport;
  readonly runImageDisk: RunImageDisk | null;
}
export type ServiceHealth = ReportedServiceHealth | null;

export interface WorkerStatus extends RegisteredWorker {
  readonly slotsInUse: number;
  readonly currentRuns: readonly WorkerRun[];
  readonly localLlm: ServiceHealth;
  readonly runImageDiskOverBudget: RunImageDisk | null;
}

export interface WorkerWarning {
  readonly title: string;
  readonly todo: string;
}

export interface WorkerListing extends WorkerStatus {
  readonly runImageDiskWarning: WorkerWarning | null;
}

export type WorkerSummary = Pick<
  WorkerStatus,
  "name" | "kind" | "state" | "draining" | "lastSeenAt" | "services" | "localLlm"
>;

export interface WorkerGroup {
  readonly name: string;
  readonly workers: readonly WorkerSummary[];
}

export type PlacementWait = "no-worker" | "offline" | "service-unhealthy" | "busy" | "ready";

interface PlacedWorker extends WorkerSummary {
  readonly wait: Exclude<PlacementWait, "no-worker">;
}

export interface RunPlacement {
  readonly group: string;
  readonly services: readonly WorkerService[];
  readonly wait: PlacementWait;
  readonly deadline: string;
  readonly queueTimeout: string;
  readonly workers: readonly PlacedWorker[];
}

export interface PlacementFix {
  readonly command?: string;
  readonly confidence: number;
  readonly rationale: string;
}

export interface PlacementWords {
  readonly reason: string;
  readonly summary: string;
  readonly fixes: readonly PlacementFix[];
}

export interface ExplainedPlacement extends RunPlacement {
  readonly words: PlacementWords;
}

export interface PlacementTarget extends WorkerEnvironment {
  readonly profile: string;
  readonly services: readonly WorkerService[];
}

const WORKER_FITS = [
  "no-group",
  "no-service",
  "offline",
  "service-unhealthy",
  "busy",
  "ready",
] as const;
export type WorkerFit = (typeof WORKER_FITS)[number];

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
  readonly code: string;
  readonly expiresAt: string;
}

export interface WorkerCredential {
  readonly worker: RegisteredWorker;
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
  placement(
    run: PlacementTarget & { readonly runId: string; readonly queueTimeout: string },
  ): Promise<RunPlacement>;
  revoke(id: string, issuedBy: string | null): Promise<RegisteredWorker>;
  authenticate(workerId: string, tokenId: string): Promise<RegisteredWorker>;
  session(
    identity: WorkerIdentity,
    target: WorkerEnvironment & { readonly profile: string },
  ): Promise<RegisteredWorker>;
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

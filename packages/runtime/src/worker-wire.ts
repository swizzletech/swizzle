// The worker HTTP contract, defined once. Each route names its request and reply schema: the API
// registers the request as the route's Fastify body schema (`workerBodySchema`), and the worker
// parses every reply with the same schema (`readWorkerReply`). The static types below derive from
// the schemas, so neither side declares a message shape of its own.

import {
  AUTOMATION_RUNTIME_EXECUTION_MODES,
  AUTOMATION_RUNTIME_LANGUAGES,
  WORKER_SERVICES,
} from "@swizzle/config";
import {
  type ExecutionLease,
  type LeaseRef,
  RUN_IMAGE_DISK_DETAILS_LIMIT,
  type RunImageDisk,
  type ServiceHealthReport,
  type WorkerCapabilities,
} from "@swizzle/db";
import { z } from "zod";
import type { RunnerImageReport, RunnerImageRequest } from "./runner-image-checks.js";

/** Files and bytes of one deployment bundle, on both sides of the transfer. */
export const MAX_SOURCE_FILES = 4_096;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
/** Characters of stdout or stderr a report carries: the child's output limit. */
const MAX_REPORT_STREAM_LENGTH = 1_048_576;
/** Characters of a reported failure's message, and of its cause or stack. */
export const MAX_FAILURE_MESSAGE_LENGTH = 8_192;
export const MAX_FAILURE_DETAIL_LENGTH = 65_536;
/** Characters of one output request the API accepts, and the size the worker splits output into. */
const MAX_OUTPUT_CHUNK_LENGTH = 65_536;
export const OUTPUT_CHUNK_LENGTH = 16_384;
/** Deployments a worker reports it has prepared. */
const MAX_KNOWN_DEPLOYMENTS = 4_096;
const MAX_TASK_ID_LENGTH = 180;
const RUN_IMAGE_TAG = /^swizzle-run:[0-9a-f]{24}$/u;

const count = z.int().min(0);

const leaseOwnership = {
  taskId: z.string().min(1).max(MAX_TASK_ID_LENGTH),
  workerId: z.uuid(),
  generation: z.int().min(1),
  executionNumber: count,
  expiresAt: z.string().max(40),
  remainingMs: count,
};
const executionLease = z.union([
  z.strictObject({ ...leaseOwnership, runId: z.uuid(), checkId: z.null(), dueAt: z.null() }),
  z.strictObject({ ...leaseOwnership, runId: z.null(), checkId: z.uuid(), dueAt: z.string() }),
]) satisfies z.ZodType<ExecutionLease>;
/** Every request after the pull names its execution by task and generation only. */
const leaseRequest = {
  lease: z.strictObject({
    taskId: leaseOwnership.taskId,
    generation: leaseOwnership.generation,
  }) satisfies z.ZodType<LeaseRef>,
};

const executionSource = z
  .array(
    z.strictObject({
      path: z.string(),
      data: z.string(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      executable: z.boolean(),
    }),
  )
  .max(MAX_SOURCE_FILES);
/** One file of an immutable deployment bundle: a relative path without links, base64 content. */
export type ExecutionSource = z.output<typeof executionSource>;
const executionSecrets = z.record(z.string(), z.string());
/** Declared secrets, connection access tokens and the run's link key, by variable name. */
export type ExecutionSecrets = z.output<typeof executionSecrets>;

const text = z.string().exactOptional();
const executionAssignment = z.strictObject({
  lease: executionLease,
  script: z.enum(["run", "check"]),
  traceContext: z.record(z.string(), z.string()),
  /** Digest of the bundle manifest. The worker refuses any other source. */
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  options: z.strictObject({
    attempt: count.exactOptional(),
    environmentName: z.string(),
    executionNumber: count.exactOptional(),
    grantMaxTimeoutMs: z.number().nullable().exactOptional(),
    inlineJson: text,
    runId: text,
    runtimeMetadata: z
      .strictObject({
        automationId: text,
        automationName: text,
        parentRunId: text,
        version: text,
        versionId: text,
      })
      .exactOptional(),
    stateSnapshot: z.record(z.string(), z.unknown()).exactOptional(),
    stepsSnapshot: z.record(z.string(), z.unknown()).exactOptional(),
    triggerType: text,
    webhookContext: z
      .strictObject({
        headers: z.record(z.string(), z.string()),
        rawBodyBase64: z.string(),
        rawBodyByteLength: count,
        rawBodySha256: z.string(),
      })
      .nullable()
      .exactOptional(),
  }),
});
/**
 * What a pull hands an accepted execution. It holds no source and no secret value: the worker
 * fetches both through its ExecutionChannel, so a lost pull response delivers nothing.
 */
export type ExecutionAssignment = z.output<typeof executionAssignment>;

const failureDetail = z.string().max(MAX_FAILURE_DETAIL_LENGTH).nullable().exactOptional();
const executionReport = z.strictObject({
  exitCode: z.int().nullable(),
  stdout: z.string().max(MAX_REPORT_STREAM_LENGTH),
  stderr: z.string().max(MAX_REPORT_STREAM_LENGTH),
  durationMs: z.int().min(0).max(2_147_483_647),
  phases: z
    .strictObject({
      image: z.number().min(0).exactOptional(),
      sandbox: z.number().min(0).exactOptional(),
      process: z.number().min(0).exactOptional(),
      standby: z.boolean().exactOptional(),
    })
    .exactOptional(),
  failure: z
    .strictObject({
      code: z.string().max(64),
      message: z.string().max(MAX_FAILURE_MESSAGE_LENGTH),
      signal: z.string().max(32).nullable(),
      cause: failureDetail,
      stack: failureDetail,
    })
    .nullable(),
});
/** What a worker reports of a finished process. The server derives success from it. */
export type ExecutionReport = z.output<typeof executionReport>;

const preparationSnapshot = z.strictObject({
  activeIds: z.array(z.string()),
  deployments: z.array(
    z.strictObject({
      automationName: z.string(),
      deploymentId: z.string(),
      deployedAt: z.string(),
      files: executionSource,
    }),
  ),
});
/** The active deployments of the worker's reach, with the bundles it has not prepared yet. */
export type PreparationSnapshot = z.output<typeof preparationSnapshot>;
export type PreparationBundle = PreparationSnapshot["deployments"][number];

const accepted = z.strictObject({ accepted: z.literal(true) });
const runImageTag = z.string().regex(RUN_IMAGE_TAG);
const runImageDisk = z.strictObject({
  activeBytes: count,
  unmeasuredActiveImagesOmitted: count,
  unmeasuredActiveImages: z
    .array(
      z
        .strictObject({
          id: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
          tags: z.array(runImageTag).max(1).readonly(),
        })
        .readonly(),
    )
    .max(RUN_IMAGE_DISK_DETAILS_LIMIT)
    .readonly(),
  budgetBytes: z.int().min(1),
}) satisfies z.ZodType<RunImageDisk>;

const TOOL_FIELD_LENGTH = 80;
const MAX_LANGUAGES = 8;
// The runner image alone has over 400 executables (infra/docker/runner-tools.mjs).
const MAX_BINARIES = 2048;
const tools = <Name extends z.ZodType<string>>(name: Name, max: number) =>
  z
    .array(
      z.strictObject({ name, version: z.string().max(TOOL_FIELD_LENGTH).nullable() }).readonly(),
    )
    .max(max)
    .readonly();
const workerCapabilities = z.strictObject({
  languages: tools(z.enum(AUTOMATION_RUNTIME_LANGUAGES), MAX_LANGUAGES),
  binaries: tools(z.string().min(1).max(TOOL_FIELD_LENGTH), MAX_BINARIES),
  executionModes: z.array(z.enum(AUTOMATION_RUNTIME_EXECUTION_MODES)).max(8).readonly(),
  dependencyPackaging: z.strictObject({ node: z.boolean(), python: z.boolean() }),
}) satisfies z.ZodType<WorkerCapabilities>;
const serviceHealth = z.partialRecord(
  z.enum(WORKER_SERVICES),
  z.enum(["healthy", "unhealthy", "disabled"]),
) satisfies z.ZodType<ServiceHealthReport>;

/** A worker route: its path, its request and reply schemas, and its body limit in bytes. */
export interface WorkerRoute<Request, Reply> {
  readonly path: `/worker/${string}`;
  readonly request: z.ZodType<Request>;
  readonly reply: z.ZodType<Reply>;
  readonly bodyLimit?: number;
}
const route = <Request, Reply>(
  path: `/worker/${string}`,
  request: z.ZodType<Request>,
  reply: z.ZodType<Reply>,
  bodyLimit?: number,
): WorkerRoute<Request, Reply> => ({
  path,
  request,
  reply,
  ...(bodyLimit === undefined ? {} : { bodyLimit }),
});

/** The routes a worker calls with its credential, enrollment and token renewal aside. */
export const WORKER_ROUTES = {
  imageChecks: route(
    "/worker/image-checks",
    z.strictObject({
      reports: z
        .array(
          z.strictObject({
            id: z.uuid(),
            result: z.discriminatedUnion("kind", [
              z.strictObject({ kind: z.literal("ready"), capabilities: workerCapabilities }),
              z.strictObject({ kind: z.literal("unavailable"), message: z.string().max(4096) }),
            ]),
          }) satisfies z.ZodType<RunnerImageReport>,
        )
        .max(8),
    }),
    z.strictObject({
      requests: z
        .array(
          z.strictObject({
            id: z.uuid(),
            image: z.string().min(1).max(512),
          }) satisfies z.ZodType<RunnerImageRequest>,
        )
        .max(8),
    }),
    8 * 2_100_000,
  ),
  drain: route("/worker/drain", z.strictObject({ draining: z.boolean() }), accepted),
  /**
   * The heartbeat: what the host can run, the health of each service it runs, and the disk the
   * last image prune pass measured, null before the first.
   */
  runtime: route(
    "/worker/runtime",
    z.strictObject({
      capabilities: workerCapabilities,
      services: serviceHealth,
      runImageDisk: runImageDisk.nullable(),
    }),
    accepted,
    // Tool names/versions escape sixfold; image IDs and run tags contain only ASCII.
    (MAX_LANGUAGES + MAX_BINARIES) * (2 * 6 * TOOL_FIELD_LENGTH + 32) +
      RUN_IMAGE_DISK_DETAILS_LIMIT * (71 + 36 + 64) +
      4_096,
  ),
  preparations: route(
    "/worker/preparations",
    z.strictObject({ knownIds: z.array(z.uuid()).max(MAX_KNOWN_DEPLOYMENTS) }),
    preparationSnapshot,
    200_000,
  ),
  /** Records the run image tag of a deployment before the worker assembles it. */
  runImage: route(
    "/worker/run-images",
    z.strictObject({ deploymentId: z.uuid(), tag: runImageTag }),
    accepted,
  ),
  /** The tags this worker recorded for active versions, which its next prune pass keeps. */
  runImageKeep: route(
    "/worker/run-images/keep",
    z.strictObject({}),
    z.strictObject({ keep: z.array(runImageTag) }),
  ),
  pull: route(
    "/worker/pull",
    z.strictObject({}),
    z.strictObject({ assignment: executionAssignment.nullable() }),
  ),
  renew: route(
    "/worker/lease/renew",
    z.strictObject(leaseRequest),
    z.strictObject({ lease: executionLease }),
  ),
  source: route(
    "/worker/source",
    z.strictObject(leaseRequest),
    z.strictObject({ files: executionSource }),
  ),
  start: route(
    "/worker/start",
    z.strictObject(leaseRequest),
    z.strictObject({ secrets: executionSecrets }),
  ),
  ready: route("/worker/ready", z.strictObject(leaseRequest), accepted),
  output: route(
    "/worker/output",
    z.strictObject({
      ...leaseRequest,
      sequence: z.int().min(1),
      stream: z.enum(["stdout", "stderr"]),
      chunk: z.string().max(MAX_OUTPUT_CHUNK_LENGTH),
    }),
    accepted,
    300_000,
  ),
  complete: route(
    "/worker/complete",
    z.strictObject({ ...leaseRequest, report: executionReport }),
    accepted,
    // JSON escaping can expand each of the two streams sixfold.
    14 * MAX_REPORT_STREAM_LENGTH,
  ),
} as const;

/** The JSON schema Fastify checks a route's request body against. */
export function workerBodySchema(route: WorkerRoute<unknown, unknown>): Record<string, unknown> {
  return z.toJSONSchema(route.request, { target: "draft-7", io: "input" });
}

/** Parses a route's reply, or throws without echoing the reply. */
export function readWorkerReply<Reply>(route: WorkerRoute<unknown, Reply>, value: unknown): Reply {
  const parsed = route.reply.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${route.path} response.`);
  return parsed.data;
}

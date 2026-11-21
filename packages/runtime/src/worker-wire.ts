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

export const MAX_SOURCE_FILES = 4_096;
export const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_REPORT_STREAM_LENGTH = 1_048_576;
export const MAX_FAILURE_MESSAGE_LENGTH = 8_192;
export const MAX_FAILURE_DETAIL_LENGTH = 65_536;
const MAX_OUTPUT_CHUNK_LENGTH = 65_536;
export const OUTPUT_CHUNK_LENGTH = 16_384;
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
export type ExecutionSource = z.output<typeof executionSource>;
const executionSecrets = z.record(z.string(), z.string());
export type ExecutionSecrets = z.output<typeof executionSecrets>;

const text = z.string().exactOptional();
const executionAssignment = z.strictObject({
  lease: executionLease,
  script: z.enum(["run", "check"]),
  traceContext: z.record(z.string(), z.string()),
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
export type PreparationSnapshot = z.output<typeof preparationSnapshot>;
export type PreparationBundle = PreparationSnapshot["deployments"][number];

const accepted = z.strictObject({ accepted: z.literal(true) });
const runImageTag = z.string().regex(RUN_IMAGE_TAG);
const runImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const diskBudget = {
  activeBytes: count,
  budgetBytes: z.int().min(1),
};
const detailedLegacyDisk = z.strictObject({
  ...diskBudget,
  unmeasuredActiveImagesOmitted: count,
  unmeasuredActiveImages: z
    .array(
      z
        .strictObject({
          id: runImageId,
          tags: z.array(runImageTag).max(1).readonly(),
        })
        .readonly(),
    )
    .max(RUN_IMAGE_DISK_DETAILS_LIMIT)
    .readonly(),
});
const legacyDisk = z
  .union([detailedLegacyDisk, z.strictObject(diskBudget)])
  .transform((disk): RunImageDisk => {
    const { activeBytes, budgetBytes } = disk;
    const unmeasured =
      "unmeasuredActiveImages" in disk
        ? {
            images: disk.unmeasuredActiveImages.map(({ id, tags }) => ({
              id,
              tag: tags[0] ?? null,
            })),
            total: Math.min(
              disk.unmeasuredActiveImages.length + disk.unmeasuredActiveImagesOmitted,
              Number.MAX_SAFE_INTEGER,
            ),
          }
        : { images: [], total: 0 };
    return { activeBytes, budgetBytes, unmeasured };
  });
const runImageDisk = z.union([
  z.strictObject({
    ...diskBudget,
    unmeasured: z
      .strictObject({
        images: z
          .array(z.strictObject({ id: runImageId, tag: runImageTag.nullable() }).readonly())
          .max(RUN_IMAGE_DISK_DETAILS_LIMIT)
          .readonly(),
        total: count,
      })
      .refine(({ images, total }) => total >= images.length),
  }),
  legacyDisk,
]) satisfies z.ZodType<RunImageDisk>;

const TOOL_FIELD_LENGTH = 80;
const MAX_LANGUAGES = 8;
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
              z.strictObject({ kind: z.literal("unverified") }),
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
  runtime: route(
    "/worker/runtime",
    z.strictObject({
      capabilities: workerCapabilities,
      services: serviceHealth,
      runImageDisk: runImageDisk.nullable(),
    }),
    accepted,
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
  runImage: route(
    "/worker/run-images",
    z.strictObject({ deploymentId: z.uuid(), tag: runImageTag }),
    accepted,
  ),
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
    14 * MAX_REPORT_STREAM_LENGTH,
  ),
} as const;

export function workerBodySchema(route: WorkerRoute<unknown, unknown>): Record<string, unknown> {
  return z.toJSONSchema(route.request, { target: "draft-7", io: "input" });
}

export function readWorkerReply<Reply>(route: WorkerRoute<unknown, Reply>, value: unknown): Reply {
  const parsed = route.reply.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid ${route.path} response.`);
  return parsed.data;
}

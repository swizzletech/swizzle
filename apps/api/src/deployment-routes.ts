import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { normalizeWebhookPath } from "@swizzle/config";
import { ENVIRONMENT_NAME_PATTERN } from "@swizzle/db/postgres";
import { AutomationRuntimeError } from "@swizzle/runtime";
import type { ApplyResponse, DeploymentCheckResponse } from "@swizzle/runtime/http-contract";
import type { PlatformDeployOptions, PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyRequest } from "fastify";
import { x as tarExtract } from "tar";

import {
  type ApiServer,
  formatSecretDeclarationCollisionWarnings,
  requestValidationError,
  serializeDeploymentResponse,
  visibleCollisions,
  webhookUrl,
} from "./http-shared.js";

export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_BUNDLE_BYTES = 50 * 1024 * 1024;
const MAX_BUNDLE_FILES = 10_000;

const BUNDLE_ENTRY_TYPES = new Set(["Directory", "File", "OldFile", "ContiguousFile"]);

/**
 * A tar `filter` that refuses traversal, links and decompression bombs. tar calls the filter
 * outside the extract pipeline's error path, where a throw crashes the process, so the filter
 * reports a refusal through `reject`, which must stop the extraction, and skips the entry.
 */
export function createBundleEntryFilter(
  reject: (error: Error) => void,
): (entryPath: string, entry: { readonly size?: number; readonly type?: string }) => boolean {
  let extractedBytes = 0;
  let entries = 0;
  const problemWith = (
    entryPath: string,
    entry: { readonly size?: number; readonly type?: string },
  ) => {
    const normalized = path.posix.normalize(entryPath.replaceAll("\\", "/"));
    if (
      entryPath.includes("\0") ||
      path.posix.isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      return `Unsafe bundle path: ${entryPath}`;
    }
    if (!BUNDLE_ENTRY_TYPES.has(entry.type ?? "")) {
      return `Unsupported bundle entry type ${entry.type ?? "unknown"}: ${entryPath}`;
    }
    entries += 1;
    extractedBytes += entry.size ?? 0;
    if (entries > MAX_BUNDLE_FILES) return `Bundle contains more than ${MAX_BUNDLE_FILES} entries.`;
    if (extractedBytes > MAX_EXTRACTED_BUNDLE_BYTES) {
      return `Expanded bundle exceeds ${MAX_EXTRACTED_BUNDLE_BYTES} bytes.`;
    }
    return null;
  };
  return (entryPath, entry) => {
    const problem = problemWith(entryPath, entry);
    if (problem !== null) reject(new Error(problem));
    return problem === null;
  };
}

export function registerDeploymentRoutes(app: ApiServer, options: DeploymentRouteOptions): void {
  // Every check apply makes, answered instead of building: what `swizzle validate` and
  // `swizzle apply --dry-run` show (deployment-check.ts). It changes nothing, so it creates no
  // audit event (ADR 0016).
  app.post<{ Reply: DeploymentCheckResponse }>(
    "/deployment-checks",
    async (request) =>
      await withUploadedAutomation(request, options, async (deployOptions, urlOf) => {
        const check = await options.platform.checkDeployment(deployOptions);
        return { ...check, webhookUrl: urlOf(check.webhookPath) };
      }),
  );

  app.post<{ Reply: ApplyResponse }>(
    "/deployments",
    async (request) =>
      await withUploadedAutomation(request, options, async (deployOptions, urlOf, environment) => {
        const deployment = await options.platform.deployAutomationToPlatform(deployOptions);

        const collisions = await options.platform.findSecretDeclarationCollisions({
          environment: deployment.environment,
          projectId: deployment.projectId,
          excludeAutomationSlug: deployment.automationSlug,
          secretNames: deployment.config.secrets,
        });

        return {
          ...serializeDeploymentResponse(deployment),
          action: deployment.action,
          changes: deployment.changes,
          message: deployment.message,
          warnings: formatSecretDeclarationCollisionWarnings(
            await visibleCollisions(request, options.platform, environment, collisions),
          ),
          webhookUrl: urlOf(
            deployment.config.trigger.type === "webhook"
              ? normalizeWebhookPath(deployment.config.trigger.path)
              : null,
          ),
        };
      }),
  );
}

interface DeploymentRouteOptions {
  readonly artifactsDirectory?: string;
  readonly platform: PlatformServices;
}

/**
 * Reads the multipart upload `swizzle apply` sends, a `bundle` file and a `meta` JSON field,
 * extracts the bundle into a temporary directory and calls `use` with the deploy options for it.
 */
async function withUploadedAutomation<T>(
  request: FastifyRequest,
  options: DeploymentRouteOptions,
  use: (
    deployOptions: PlatformDeployOptions,
    urlOf: (webhookPath: string | null) => string | null,
    environment: string,
  ) => Promise<T>,
): Promise<T> {
  if (!request.isMultipart()) {
    return requestValidationError(
      `${request.method} ${request.routeOptions.url} requires multipart/form-data with a 'bundle' file part, ` +
        "as sent by `swizzle apply`.",
    );
  }

  let bundle: Buffer | null = null;
  let bundleFilename: string | null = null;
  let meta: {
    environment?: string;
    force?: boolean;
    expectedContentHash?: string;
    /** The project a new automation joins, by id or slug; an existing one stays where it is. */
    project?: string;
  } = {};

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "bundle") {
        return requestValidationError(
          `Unexpected file field '${part.fieldname}'. Expected 'bundle'.`,
        );
      }
      bundle = await part.toBuffer();
      bundleFilename = part.filename ?? null;
      continue;
    }

    if (part.fieldname === "meta") {
      try {
        meta = JSON.parse(part.value as string) as typeof meta;
      } catch {
        return requestValidationError("meta field must be valid JSON.");
      }
    }
  }

  if (bundle === null) {
    return requestValidationError("bundle field is required (multipart file).");
  }
  // Multipart fields bypass the route schemas, so the environment rule every query follows is
  // applied here.
  if (
    meta.environment !== undefined &&
    (typeof meta.environment !== "string" || !ENVIRONMENT_NAME_PATTERN.test(meta.environment))
  ) {
    return requestValidationError("meta.environment must be an environment name.");
  }
  if (meta.expectedContentHash !== undefined && typeof meta.expectedContentHash !== "string") {
    return requestValidationError("meta.expectedContentHash must be a string.");
  }
  if (meta.project !== undefined && typeof meta.project !== "string") {
    return requestValidationError("meta.project must be a project id or slug.");
  }
  const environment = meta.environment ?? request.server.configuredEnvironment;

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "swizzle-deploy-"));
  try {
    try {
      const extract = tarExtract({
        cwd: tempDirectory,
        filter: createBundleEntryFilter((error) => extract.abort(error)),
        preservePaths: false,
        strict: true,
      });
      await pipeline(Readable.from(bundle), extract);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AutomationRuntimeError(
        "DEPLOYMENT_BUNDLE_INVALID",
        `Could not extract uploaded bundle (${bundleFilename ?? "unnamed"}): ${message}`,
      );
    }

    return await use(
      {
        ...(options.artifactsDirectory !== undefined
          ? { artifactsDirectory: options.artifactsDirectory }
          : {}),
        automationDirectory: tempDirectory,
        environment,
        credentials: async (bound, projectId) =>
          await request.access.useCredentials(bound, projectId),
        ...(meta.expectedContentHash !== undefined
          ? { expectedSourceHash: meta.expectedContentHash }
          : {}),
        ...(meta.force === true ? { force: true } : {}),
        project: async (automation) =>
          await request.access.place(automation, meta.project, environment),
        skipReadinessCheck: meta.force === true,
      },
      (webhookPath) =>
        webhookPath === null ? null : webhookUrl(request, webhookPath, environment),
      environment,
    );
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

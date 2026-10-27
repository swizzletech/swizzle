import { BundleEmptyError, BundleTooLargeError, packAutomation } from "@swizzle/runtime";
import type {
  AutomationDeploymentResponse as ActiveDeploymentRecord,
  ApplyResponse,
  AutomationSummaryResponse as AutomationSummaryRecord,
  AutomationsResponse,
  DeploymentCheckResponse,
} from "@swizzle/runtime/http-contract";

export type ReadinessRecord = ActiveDeploymentRecord["readiness"];
export type { AutomationSummaryResponse as AutomationSummaryRecord } from "@swizzle/runtime/http-contract";

import { apiRequest, resolveApiUrl } from "./api.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  type ExactCommandOptions,
} from "./command-support.js";
import { type AutomationLike, detectCwdAutomation, resolveAutomation } from "./context.js";
import { AgentError, EXIT_CODES, warn } from "./output.js";
import type { BearerToken } from "./profile.js";

export interface ResolvedAutomationName {
  readonly slug: string;
  /** `unlisted`: no automation the caller can see has this name; the API decides what it is. */
  readonly match: "exact" | "fuzzy" | "unlisted";
  readonly confidence: number;
  readonly query: string;
}

/**
 * The slug a command acts on. A name the caller can see resolves exactly, or by a fuzzy match
 * that the output names as a warning. A slug the caller cannot see goes to the API as it is, so
 * the API's own answer reaches the caller: a 404 for an automation that does not exist, a 403
 * ACCESS_DENIED where a role is missing, such as in a protected production. Destructive commands
 * never act on a fuzzy match.
 */
export async function resolveAutomationNameOrDie(
  name: string | undefined,
  options: ApiCommandOptions & ExactCommandOptions,
  context: { readonly destructive?: boolean } = {},
): Promise<ResolvedAutomationName> {
  const input = name ?? (await detectCwdAutomation())?.name;
  if (!input) {
    throw new AgentError({
      code: "AUTOMATION_NAME_REQUIRED",
      fixCommand: "swizzle list",
      hint: "Pass an automation name, or run from inside an automation folder.",
      message: "No automation name given and no config.yaml found in this directory.",
    });
  }

  const automations = await listAutomations(options);
  const resolved = resolveAutomation<AutomationLike>(input, automations, {
    exact: options.exact === true,
  });
  if (resolved === null) {
    // The API names automations by slug, so a name that is not one reaches none; it is not
    // rewritten into another that might, even when it differs from one only in punctuation.
    if (input !== slugify(input)) {
      throw new AgentError({
        code: "AUTOMATION_NOT_FOUND",
        exitCode: EXIT_CODES.notFound,
        message: `No automation "${input}" you can see${options.environment === undefined ? "" : ` in ${options.environment}`}.`,
        hint: "Automations are named by their lowercase kebab-case slug.",
        fixCommand: `swizzle list${options.environment === undefined ? "" : ` -e ${options.environment}`}`,
      });
    }
    return { confidence: 1, match: "unlisted", query: input, slug: input };
  }

  if (resolved.match === "fuzzy" && context.destructive === true) {
    // Destructive commands never act on a guess: a near-miss like
    // `delete report` silently resolving to `reporting-daily` is unrecoverable.
    throw new AgentError({
      code: "EXACT_NAME_REQUIRED",
      exitCode: EXIT_CODES.usage,
      message: `"${input}" is not an exact automation name. Closest match: ${resolved.automation.automationSlug}.`,
      hint: "Destructive commands take the exact slug. Re-run with the full slug if the match is right.",
      fixCommand: `swizzle resolve ${input}`,
      details: { closestMatch: resolved.automation.automationSlug, query: input },
    });
  }

  if (resolved.match === "fuzzy") {
    warn(
      `resolved "${input}" -> "${resolved.automation.automationSlug}" (fuzzy match; pass --exact to disable)`,
    );
  }

  return {
    confidence: resolved.confidence,
    match: resolved.match,
    query: input,
    slug: resolved.automation.automationSlug,
  };
}

export async function listAutomations(
  options: ApiCommandOptions,
): Promise<readonly AutomationSummaryRecord[]> {
  const response = await apiRequest<AutomationsResponse>(
    buildApiUrl("/dashboard/automations", options),
  );
  return response.automations;
}

/** An automation directory packed as apply uploads it. */
export interface PackedAutomation {
  readonly bundle: Buffer;
  readonly contentHash: string;
}

/** Packs an automation directory as apply uploads it, refusing an empty or oversized one. */
export async function packAutomationOrThrow(
  automationDirectory: string,
): Promise<PackedAutomation> {
  try {
    const packed = await packAutomation(automationDirectory);
    return { bundle: packed.bundle, contentHash: packed.contentHash };
  } catch (error) {
    if (error instanceof BundleTooLargeError) {
      throw new AgentError({
        code: "BUNDLE_TOO_LARGE",
        message: error.message,
        hint: "Add unused files (node_modules, build artifacts) to an .swizzleignore, or reduce the automation.",
        details: { byteSize: error.byteSize, limitBytes: error.limitBytes },
      });
    }
    if (error instanceof BundleEmptyError) {
      throw new AgentError({
        code: "BUNDLE_EMPTY",
        message: error.message,
        hint: "Make sure config.yaml + the entrypoint are in the automation directory.",
      });
    }
    throw error;
  }
}

interface DeploymentRequest {
  readonly apiUrl: string;
  readonly environment: string;
  readonly force?: boolean;
  readonly project?: string | undefined;
  /** The profile's token; the ambient one when absent. */
  readonly token?: BearerToken | null;
}

/** POST /deployments with the packed automation: builds and deploys it. */
export async function postDeployment(
  packed: PackedAutomation,
  request: DeploymentRequest,
): Promise<ApplyResponse> {
  return await postBundle("/deployments", packed, request, 120_000);
}

/**
 * POST /deployment-checks with the packed automation: the API makes every check apply makes and
 * answers without building or deploying, so `swizzle validate` and `swizzle apply --dry-run`
 * refuse what apply refuses and approve nothing else.
 */
export async function postDeploymentCheck(
  packed: PackedAutomation,
  request: DeploymentRequest,
): Promise<DeploymentCheckResponse> {
  return await postBundle("/deployment-checks", packed, request, 30_000);
}

async function postBundle<T>(
  route: "/deployments" | "/deployment-checks",
  packed: PackedAutomation,
  request: DeploymentRequest,
  timeoutMs: number,
): Promise<T> {
  const form = new FormData();
  form.append(
    "bundle",
    new Blob([new Uint8Array(packed.bundle)], { type: "application/gzip" }),
    "automation.tar.gz",
  );
  form.append(
    "meta",
    JSON.stringify({
      environment: request.environment,
      expectedContentHash: packed.contentHash,
      ...(request.force === true ? { force: true } : {}),
      ...(request.project !== undefined ? { project: request.project } : {}),
    }),
  );
  return await apiRequest<T>(resolveApiUrl(request.apiUrl, route).toString(), {
    body: form,
    method: "POST",
    timeoutMs,
    ...(request.token !== undefined ? { token: request.token } : {}),
  });
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

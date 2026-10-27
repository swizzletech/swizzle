import { AutomationRuntimeError } from "./errors.js";

const PLATFORM_MAX_RUN_TIMEOUT_ENV = "SWIZZLE_MAX_RUN_TIMEOUT";
const DEFAULT_PLATFORM_MAX_RUN_TIMEOUT = "1h";

export interface RuntimeTimeoutPolicy {
  readonly maxTimeout: string;
  readonly maxTimeoutMs: number;
  readonly timeout: string;
  readonly timeoutMs: number;
}

export function parseRuntimeTimeout(timeoutValue: string, subject = "runtime.timeout"): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(timeoutValue.trim());
  if (!match) {
    throw new AutomationRuntimeError(
      "TIMEOUT_FORMAT_INVALID",
      `Unsupported ${subject} format: ${timeoutValue}. Use values like 500ms, 30s, 5m, or 1h.`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2] as "ms" | "s" | "m" | "h";

  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
  }
}

function resolvePlatformMaxRunTimeout(environment: NodeJS.ProcessEnv = process.env): {
  readonly label: string;
  readonly milliseconds: number;
} {
  const label =
    environment[PLATFORM_MAX_RUN_TIMEOUT_ENV]?.trim() || DEFAULT_PLATFORM_MAX_RUN_TIMEOUT;

  return {
    label,
    milliseconds: parseRuntimeTimeout(label, PLATFORM_MAX_RUN_TIMEOUT_ENV),
  };
}

export interface EffectiveTimeoutCeilingOptions {
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Per-automation timeout grant in milliseconds, if one exists for this
   * automation + environment. A grant only ever raises the ceiling — a grant
   * smaller than the global ceiling is ignored.
   */
  readonly grantMaxTimeoutMs?: number | null;
}

export interface EffectiveTimeoutCeiling {
  readonly grantApplied: boolean;
  readonly label: string;
  readonly milliseconds: number;
  readonly platformLabel: string;
  readonly platformMilliseconds: number;
}

/**
 * Render a millisecond duration in the same single-unit shorthand
 * {@link parseRuntimeTimeout} accepts (`3h`, `90m`, `500ms`). This is the
 * inverse of the `runtime.timeout` parser, so it is the canonical way to
 * display a run-timeout value (including a timeout grant) across the CLI.
 */
export function formatRuntimeTimeoutMs(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) {
    return `${milliseconds / 3_600_000}h`;
  }
  if (milliseconds % 60_000 === 0) {
    return `${milliseconds / 60_000}m`;
  }
  if (milliseconds % 1_000 === 0) {
    return `${milliseconds / 1_000}s`;
  }
  return `${milliseconds}ms`;
}

/**
 * Effective run-timeout ceiling for a single automation:
 * `max(grant.max_timeout_ms, global ceiling)`. Without a grant it is the global
 * ceiling; a grant only ever raises it, never lowers it.
 */
export function resolveEffectiveRunTimeoutCeiling(
  options: EffectiveTimeoutCeilingOptions = {},
): EffectiveTimeoutCeiling {
  const platform = resolvePlatformMaxRunTimeout(options.environment);
  const grantMs = options.grantMaxTimeoutMs ?? null;

  if (grantMs !== null && grantMs > platform.milliseconds) {
    return {
      grantApplied: true,
      label: formatRuntimeTimeoutMs(grantMs),
      milliseconds: grantMs,
      platformLabel: platform.label,
      platformMilliseconds: platform.milliseconds,
    };
  }

  return {
    grantApplied: false,
    label: platform.label,
    milliseconds: platform.milliseconds,
    platformLabel: platform.label,
    platformMilliseconds: platform.milliseconds,
  };
}

export function assertRuntimeTimeoutWithinPlatformCeiling(
  timeout: string,
  options: EffectiveTimeoutCeilingOptions = {},
): RuntimeTimeoutPolicy {
  const timeoutMs = parseRuntimeTimeout(timeout);
  const ceiling = resolveEffectiveRunTimeoutCeiling(options);

  if (timeoutMs > ceiling.milliseconds) {
    throw new AutomationRuntimeError(
      "RUNTIME_TIMEOUT_EXCEEDS_MAX",
      `runtime.timeout ${timeout} exceeds the effective run-timeout ceiling ${ceiling.label}. Grant this automation a longer ceiling with \`swizzle timeout-grant set <automation> ${timeout}\`, or raise ${PLATFORM_MAX_RUN_TIMEOUT_ENV} to lift the ceiling for every automation.`,
      {
        details: {
          environmentVariable: PLATFORM_MAX_RUN_TIMEOUT_ENV,
          grantApplied: ceiling.grantApplied,
          maxTimeout: ceiling.label,
          maxTimeoutMs: ceiling.milliseconds,
          platformMaxTimeout: ceiling.platformLabel,
          platformMaxTimeoutMs: ceiling.platformMilliseconds,
          timeout,
          timeoutMs,
        },
      },
    );
  }

  return {
    maxTimeout: ceiling.label,
    maxTimeoutMs: ceiling.milliseconds,
    timeout,
    timeoutMs,
  };
}

export function resolveEffectiveRuntimeTimeoutMs(
  timeout: string,
  options: EffectiveTimeoutCeilingOptions & { readonly fallbackMs?: number } = {},
): number {
  const fallbackMs = options.fallbackMs ?? 60_000;
  let timeoutMs: number;

  try {
    timeoutMs = parseRuntimeTimeout(timeout);
  } catch {
    return fallbackMs;
  }

  try {
    return Math.min(timeoutMs, resolveEffectiveRunTimeoutCeiling(options).milliseconds);
  } catch {
    return timeoutMs;
  }
}

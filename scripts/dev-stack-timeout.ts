export const stopTimeoutMs = Number(process.env.SWIZZLE_DEV_STOP_TIMEOUT_MS ?? 15_000);
if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0) {
  throw new Error("SWIZZLE_DEV_STOP_TIMEOUT_MS must be a positive integer");
}

export const composeTeardownTimeoutMs = Number(
  process.env.SWIZZLE_DEV_COMPOSE_TEARDOWN_TIMEOUT_MS ?? 120_000,
);
if (!Number.isSafeInteger(composeTeardownTimeoutMs) || composeTeardownTimeoutMs <= 0) {
  throw new Error("SWIZZLE_DEV_COMPOSE_TEARDOWN_TIMEOUT_MS must be a positive integer");
}

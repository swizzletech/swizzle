// Tests shorten the grace period for deliberately stubborn fixture processes.
export const stopTimeoutMs = Number(process.env.SWIZZLE_DEV_STOP_TIMEOUT_MS ?? 15_000);
if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs <= 0) {
  throw new Error("SWIZZLE_DEV_STOP_TIMEOUT_MS must be a positive integer");
}

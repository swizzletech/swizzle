/** Default execution slots for every worker, including the stack's local identity. */
export const DEFAULT_WORKER_CONCURRENCY = 2;

export function readWorkerConcurrency(value: string | undefined): number {
  const concurrency = value?.trim() ? Number(value) : DEFAULT_WORKER_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256)
    throw new Error("WORKER_CONCURRENCY must be an integer between 1 and 256.");
  return concurrency;
}

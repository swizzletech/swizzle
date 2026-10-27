/** The local LLM inference service a GPU host offers its authorized runs (ADR 0013). */
export const LOCAL_LLM_SERVICE = "local-llm";

/**
 * The named services an owner grants a worker, an automation requests in
 * `runtime.permissions.services`, and a worker reports the health of.
 */
export const WORKER_SERVICES = [LOCAL_LLM_SERVICE] as const;
export type WorkerService = (typeof WORKER_SERVICES)[number];

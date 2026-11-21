export const LOCAL_LLM_SERVICE = "local-llm";

export const WORKER_SERVICES = [LOCAL_LLM_SERVICE] as const;
export type WorkerService = (typeof WORKER_SERVICES)[number];

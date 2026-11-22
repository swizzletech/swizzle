import type { TestProject } from "vitest/node";

export function registerProjectCleanup(
  vitest: TestProject["vitest"],
  cleanup: () => void,
): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    cleanup();
  };
  const stopForSignal = (signal: "SIGINT" | "SIGTERM") => {
    try {
      stop();
    } catch (error) {
      console.error(error);
    } finally {
      queueMicrotask(() => {
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      });
    }
  };
  const interrupt = () => stopForSignal("SIGINT");
  const terminate = () => stopForSignal("SIGTERM");
  process.once("exit", stop);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  vitest.onClose(async () => stop());
  return stop;
}

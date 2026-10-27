import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const LOCAL_LISTENER = "swizzle-local-worker-api";
/** Matches `INFO (swizzle-api): Server listening at http://127.0.0.1:<port>`, colored or not. */
const LISTENING = /\(([\w-]+)\):[^\n]*?Server listening at (http:\/\/127\.0\.0\.1:\d+)/g;

/**
 * A real API process on an OS-assigned port, or on `API_PORT` when the caller restarts an API that
 * a worker must find again. The caller owns its lifetime and database. With
 * SWIZZLE_LOCAL_WORKER_TOKEN set it also serves the local worker listener, on its own port.
 */
export async function startVerificationApi(environment: NodeJS.ProcessEnv = process.env) {
  const local = Boolean(environment.SWIZZLE_LOCAL_WORKER_TOKEN);
  const child = spawn(
    "pnpm",
    ["exec", "tsx", "--conditions=swizzle-source", "apps/api/src/main.ts"],
    {
      env: {
        ...environment,
        API_PORT: environment.API_PORT ?? "0",
        API_HOST: "127.0.0.1",
        SWIZZLE_ENVIRONMENT: "local",
        NODE_ENV: "test",
        SWIZZLE_SHUTDOWN_TIMEOUT_MS: "3000",
        ...(local
          ? { SWIZZLE_LOCAL_WORKER_API_HOST: "127.0.0.1", SWIZZLE_LOCAL_WORKER_API_PORT: "0" }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  let log = "";
  const append = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-64 * 1024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const exited = once(child, "exit");
    process.kill(-child.pid, "SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
    process.kill(-child.pid, "SIGKILL");
    await exited;
  };
  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      if (spawnError !== undefined)
        throw new Error("API process could not start.", { cause: spawnError });
      const listening = new Map(
        [...log.matchAll(LISTENING)].map((match) => [match[1] === LOCAL_LISTENER, match[2]]),
      );
      const url = listening.get(false);
      const localUrl = listening.get(true);
      if (url !== undefined && (!local || localUrl !== undefined))
        return { url, localUrl: localUrl ?? null, close };
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
        throw new Error(`API did not start:\n${log}`);
      await delay(50);
    }
  } catch (error) {
    await close();
    throw error;
  }
}

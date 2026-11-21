import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const LOCAL_LISTENER = "swizzle-local-worker-api";
const LISTENING = /\(([\w-]+)\):[^\n]*?Server listening at (http:\/\/127\.0\.0\.1:\d+)/g;

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
  const killOnExit = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  process.once("exit", killOnExit);
  child.once("close", () => process.off("exit", killOnExit));
  const ready = new Promise<{ url: string; localUrl: string | null }>((resolve, reject) => {
    child.once("error", (error) => {
      reject(new Error("API process could not start.", { cause: error }));
    });
    let log = "";
    let listening = false;
    child.once("close", () => {
      reject(new Error(`API did not start:\n${log}`));
    });
    const append = (chunk: Buffer) => {
      if (listening) return;
      log = (log + chunk.toString()).slice(-64 * 1024);
      const addresses = new Map(
        [...log.matchAll(LISTENING)].map((match) => [match[1] === LOCAL_LISTENER, match[2]]),
      );
      const url = addresses.get(false);
      const localUrl = addresses.get(true);
      if (url === undefined || (local && localUrl === undefined)) return;
      listening = true;
      resolve({ url, localUrl: localUrl ?? null });
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const exited = once(child, "exit");
    process.kill(-child.pid, "SIGTERM");
    if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
    process.kill(-child.pid, "SIGKILL");
    await exited;
  };
  try {
    return { ...(await ready), close };
  } catch (error) {
    await close();
    throw error;
  }
}

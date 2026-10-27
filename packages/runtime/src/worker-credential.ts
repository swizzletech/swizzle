import { randomBytes, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

export type WorkerCredentialSource =
  | { readonly kind: "configured"; readonly token: string }
  | { readonly kind: "file"; readonly path: string };

export class WorkerHttpError extends Error {
  constructor(
    readonly status: number,
    route: string,
  ) {
    super(`Worker request ${route} failed (${status}).`);
  }
}

const TOKEN = /^swz_[A-Za-z0-9_-]{43}$/u;
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60_000;

/**
 * Owns durable rotation. A saved candidate recovers a renewal whose response was lost.
 * `onReply` sees the Date header of every API reply, refusals included.
 */
export async function createWorkerRequest(
  origin: URL,
  source: WorkerCredentialSource,
  shutdown: AbortSignal,
  onReply?: (serverDate: string | null) => void,
) {
  const values = source.kind === "file" ? parseEnv(await readFile(source.path, "utf8")) : {};
  const initial = source.kind === "configured" ? source.token : values.SWIZZLE_WORKER_TOKEN;
  if (!initial) throw new Error("Worker credential file has no SWIZZLE_WORKER_TOKEN.");
  let token = initial;
  const raw = async (credential: string, route: string, body: unknown, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(route === "/worker/pull" ? 16 * 60_000 : 80_000);
    const response = await fetch(new URL(route, origin), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    onReply?.(response.headers.get("date"));
    if (!response.ok) throw new WorkerHttpError(response.status, route);
    const value: unknown = await response.json();
    return value;
  };
  const save = async () => {
    if (source.kind !== "file") return;
    const draft = path.join(path.dirname(source.path), `.worker-${randomUUID()}.draft`);
    try {
      const file = await open(draft, "wx", 0o600);
      try {
        await file.writeFile(
          Object.entries(values)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
        );
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(draft, source.path);
      const directory = await open(path.dirname(source.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(draft, { force: true });
    }
  };
  let rotation: Promise<void> | undefined;
  const renew = async () => {
    if (source.kind !== "file") return;
    const expires = Date.parse(values.SWIZZLE_WORKER_TOKEN_EXPIRES_AT ?? "");
    if (!Number.isFinite(expires))
      throw new Error("Worker credential file has no valid token expiry.");
    if (!values.SWIZZLE_WORKER_PENDING_TOKEN && expires - Date.now() > RENEW_BEFORE_MS) return;
    const candidate =
      values.SWIZZLE_WORKER_PENDING_TOKEN ?? `swz_${randomBytes(32).toString("base64url")}`;
    if (!TOKEN.test(candidate))
      throw new Error("Worker credential file has an invalid pending token.");
    if (!values.SWIZZLE_WORKER_PENDING_TOKEN) {
      values.SWIZZLE_WORKER_PENDING_TOKEN = candidate;
      try {
        await save();
      } catch (error) {
        delete values.SWIZZLE_WORKER_PENDING_TOKEN;
        throw error;
      }
    }
    let worker: unknown;
    try {
      worker = await raw(candidate, "/worker/heartbeat", {}, shutdown);
    } catch (error) {
      if (!(error instanceof WorkerHttpError) || ![401, 403].includes(error.status)) throw error;
      const result = await raw(token, "/worker/token/renew", { token: candidate }, shutdown);
      if (
        typeof result !== "object" ||
        result === null ||
        !("token" in result) ||
        result.token !== candidate ||
        !("worker" in result)
      )
        throw new Error("Invalid worker token renewal response.");
      worker = result.worker;
    }
    if (
      typeof worker !== "object" ||
      worker === null ||
      !("tokenExpiresAt" in worker) ||
      typeof worker.tokenExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(worker.tokenExpiresAt))
    )
      throw new Error("Invalid worker token expiry response.");
    // Set memory only after the file is durable. A failed save keeps the candidate for recovery.
    values.SWIZZLE_WORKER_TOKEN = candidate;
    values.SWIZZLE_WORKER_TOKEN_EXPIRES_AT = worker.tokenExpiresAt;
    delete values.SWIZZLE_WORKER_PENDING_TOKEN;
    try {
      await save();
    } catch (error) {
      values.SWIZZLE_WORKER_PENDING_TOKEN = candidate;
      throw error;
    }
    token = candidate;
  };
  return async (route: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted();
    if (!shutdown.aborted) {
      rotation ??= renew().finally(() => {
        rotation = undefined;
      });
      await waitForRotation(rotation, signal);
    }
    const sent = token;
    try {
      return await raw(sent, route, body, signal);
    } catch (error) {
      // A request authenticated just before rotation may be refused by a generation check.
      if (error instanceof WorkerHttpError && [401, 403].includes(error.status)) {
        if (rotation !== undefined) await waitForRotation(rotation, signal);
        if (sent !== token) return await raw(token, route, body, signal);
      }
      throw error;
    }
  };
}

/** Cancel only this caller's wait, preserving the shared operation for other requests. */
async function waitForRotation(rotation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return await rotation;
  signal.throwIfAborted();
  let onAbort = () => {};
  const canceled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([rotation, canceled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

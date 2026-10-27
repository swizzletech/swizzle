// The HTTP server between the worker and the Docker socket. It routes each request through
// policy.ts, looks up the owner of the container, exec or image a request names, and forwards an
// allowed request to the daemon with the container's id in place of the name it was given, so a
// container renamed after the check cannot receive the call. Docker's hijacked streams (attach and
// exec start) pass the same check, and the broker forwards raw bytes only once the daemon has
// answered 101; before that, it holds what the client sends, and nothing after the request body
// reaches the daemon.
//
// Each client request owns what the broker asks of the daemon for it: when the client disconnects,
// its lookups and its forwarded request are closed. Lookups have a deadline; a forwarded call has
// none, because a wait or an attach lasts as long as its container.

import { createServer, type IncomingMessage, request, type Server, STATUS_CODES } from "node:http";
import type { Socket } from "node:net";

import {
  type BrokerScope,
  checkCreate,
  checkExec,
  checkList,
  isRecord,
  mayHijack,
  ownedBy,
  type Route,
  route,
} from "./policy.js";

/** Bounds headers and create/exec bodies, including large selected-image reference filters. */
const REQUEST_LIMIT_BYTES = 1_048_576;
/** How long the daemon may take to answer an ownership lookup, as long as a worker control call. */
const LOOKUP_TIMEOUT_MS = 5_000;

type Decision =
  | { readonly allow: true; readonly path: string; readonly body: Buffer | null }
  | { readonly allow: false; readonly status: number; readonly message: string };

export function createBroker(options: {
  readonly socketPath: string;
  readonly scope: BrokerScope;
  readonly onDeny?: (method: string, url: string, message: string) => void;
}): Server {
  const { socketPath, scope } = options;
  const refused = (req: IncomingMessage, decision: Decision) => {
    if (!decision.allow && decision.status === 403) {
      options.onDeny?.(req.method ?? "", req.url ?? "", decision.message);
    }
  };

  const server = createServer({ maxHeaderSize: REQUEST_LIMIT_BYTES }, (req, res) => {
    const client = new AbortController();
    res.on("close", () => client.abort());
    const daemon = (path: string) => daemonJson(socketPath, path, client.signal);
    void decide(req, false, scope, daemon)
      .then((decision) => {
        refused(req, decision);
        if (!decision.allow) {
          res.writeHead(decision.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: decision.message }));
          return;
        }
        const upstream = request(
          {
            headers: req.headers,
            method: req.method,
            path: decision.path,
            signal: client.signal,
            socketPath,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            // A wait answers with headers at once and its body only when the container exits,
            // and the CLI starts the container only once it has those headers.
            res.flushHeaders();
            response.on("error", () => res.destroy());
            response.pipe(res);
          },
        );
        upstream.on("error", () => res.destroy());
        if (decision.body === null) req.pipe(upstream);
        else upstream.end(decision.body);
      })
      .catch(() => res.destroy());
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const client = new AbortController();
    socket.on("close", () => client.abort());
    // Read from the start, not after the ownership lookup: once holdUntilSwitch makes the socket
    // flow, Node 26 drops a body chunk of an upgrade request that nothing reads yet.
    const requestBody = framedBody(req) ? readBody(req).catch(() => null) : Promise.resolve(null);
    const held = holdUntilSwitch(socket, head);
    const daemon = (path: string) => daemonJson(socketPath, path, client.signal);
    void decide(req, true, scope, daemon)
      .then(async (decision) => {
        refused(req, decision);
        if (!decision.allow) {
          answerAndClose(
            socket,
            decision.status,
            "application/json",
            JSON.stringify({ message: decision.message }),
          );
          return;
        }
        const body = await requestBody;
        if (body === null) {
          answerAndClose(
            socket,
            400,
            "application/json",
            '{"message":"docker-broker: unreadable request body"}',
          );
          return;
        }
        const upstream = request({
          headers: req.headers,
          method: req.method,
          path: decision.path,
          signal: client.signal,
          socketPath,
        });
        upstream.on("upgrade", (response, stream: Socket, upstreamHead: Buffer) => {
          socket.write(
            `HTTP/1.1 101 ${response.statusMessage}\r\n${headerLines(response.rawHeaders)}\r\n`,
          );
          socket.write(upstreamHead);
          stream.write(held.release());
          stream.on("error", () => socket.destroy());
          socket.on("close", () => stream.destroy());
          socket.pipe(stream).pipe(socket);
        });
        // The daemon answered without a raw stream, as for a detached exec or an error. Relay the
        // answer and close: a byte the client sent after it would reach the daemon unchecked.
        upstream.on("response", (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            answerAndClose(
              socket,
              response.statusCode ?? 502,
              response.headers["content-type"] ?? "application/json",
              Buffer.concat(chunks),
            ),
          );
        });
        upstream.on("error", () => socket.destroy());
        upstream.end(body);
      })
      .catch(() => socket.destroy());
  });
  return server;
}

async function decide(
  req: IncomingMessage,
  upgrade: boolean,
  scope: BrokerScope,
  daemon: (path: string) => Promise<DaemonAnswer>,
): Promise<Decision> {
  const url = req.url ?? "/";
  let routed: Route;
  try {
    routed = route(req.method ?? "", url);
  } catch {
    return {
      allow: false,
      message: "docker-broker: the request target is not a path",
      status: 400,
    };
  }
  if (routed.kind === "deny") return refuse(routed.reason);
  // A raw stream skips the body checks, so only the two calls that need one may open it.
  if (upgrade && !mayHijack(routed)) return refuse("this call cannot switch to a raw stream");
  try {
    return await decideRoute(req, url, routed, scope, daemon);
  } catch (error) {
    if (error instanceof LookupTimeout) {
      return { allow: false, message: `docker-broker: ${error.message}`, status: 504 };
    }
    return { allow: false, message: `docker-broker: ${String(error)}`, status: 502 };
  }
}

async function decideRoute(
  req: IncomingMessage,
  url: string,
  routed: Exclude<Route, { kind: "deny" }>,
  scope: BrokerScope,
  daemon: (path: string) => Promise<DaemonAnswer>,
): Promise<Decision> {
  switch (routed.kind) {
    case "forward":
      return { allow: true, body: null, path: url };
    case "list": {
      const reason = checkList(routed.filters, scope);
      return reason === null ? { allow: true, body: null, path: url } : refuse(reason);
    }
    case "create": {
      const body = await readBody(req);
      const reason =
        body === null ? "the create body is too large" : checkCreate(parse(body), scope);
      return reason === null ? { allow: true, body, path: url } : refuse(reason);
    }
    case "commit": {
      const owner = await ownedContainer(routed.container, scope, daemon);
      if (!owner.allow) return owner;
      const rewritten = new URL(url, "http://broker");
      rewritten.searchParams.set("container", owner.id);
      return { allow: true, body: null, path: `${rewritten.pathname}${rewritten.search}` };
    }
    case "container": {
      const owner = await ownedContainer(routed.container, scope, daemon);
      if (!owner.allow) return owner;
      const path = url.replace(`/containers/${routed.container}`, `/containers/${owner.id}`);
      if (routed.action !== "exec") return { allow: true, body: null, path };
      const body = await readBody(req);
      const reason = body === null ? "the exec body is too large" : checkExec(parse(body));
      return reason === null ? { allow: true, body, path } : refuse(reason);
    }
    case "exec": {
      const exec = await daemon(`/exec/${routed.exec}/json`);
      if (exec.status !== 200) return passThrough(exec);
      const container = isRecord(exec.body) ? exec.body.ContainerID : undefined;
      if (typeof container !== "string") return refuse("the exec names no container");
      const owner = await ownedContainer(container, scope, daemon);
      return owner.allow ? { allow: true, body: null, path: url } : owner;
    }
    case "image": {
      const image = await daemon(`/images/${routed.image}/json`);
      if (image.status !== 200) return passThrough(image);
      const labels =
        isRecord(image.body) && isRecord(image.body.Config) ? image.body.Config.Labels : null;
      return ownedBy(labels, scope)
        ? { allow: true, body: null, path: url }
        : refuse(`the image ${routed.image} does not belong to stack ${scope.stack}`);
    }
  }
}

async function ownedContainer(
  name: string,
  scope: BrokerScope,
  daemon: (path: string) => Promise<DaemonAnswer>,
): Promise<{ readonly allow: true; readonly id: string } | Exclude<Decision, { allow: true }>> {
  const container = await daemon(`/containers/${name}/json`);
  if (container.status !== 200) return passThrough(container);
  const body = isRecord(container.body) ? container.body : {};
  const labels = isRecord(body.Config) ? body.Config.Labels : null;
  if (typeof body.Id !== "string" || !ownedBy(labels, scope)) {
    return refuse(`the container ${name} does not belong to stack ${scope.stack}`);
  }
  return { allow: true, id: body.Id };
}

function refuse(reason: string): Exclude<Decision, { allow: true }> {
  return { allow: false, message: `docker-broker refused the call: ${reason}`, status: 403 };
}

/** The daemon's own answer to a lookup that failed, such as "No such container" with 404. */
function passThrough(answer: DaemonAnswer): Exclude<Decision, { allow: true }> {
  const message =
    isRecord(answer.body) && typeof answer.body.message === "string" ? answer.body.message : "";
  return { allow: false, message, status: answer.status };
}

interface DaemonAnswer {
  readonly status: number;
  readonly body: unknown;
}

class LookupTimeout extends Error {}

/** A lookup for one client request, closed when that client disconnects or the deadline passes. */
function daemonJson(socketPath: string, path: string, client: AbortSignal): Promise<DaemonAnswer> {
  const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) =>
      reject(
        deadline.aborted
          ? new LookupTimeout(
              `the daemon did not answer GET ${path} within ${LOOKUP_TIMEOUT_MS / 1_000} seconds`,
            )
          : error,
      );
    const lookup = request(
      { method: "GET", path, signal: AbortSignal.any([client, deadline]), socketPath },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ body: parse(Buffer.concat(chunks)), status: response.statusCode ?? 502 }),
        );
        response.on("error", fail);
      },
    );
    lookup.on("error", fail);
    lookup.end();
  });
}

/** Writes a complete HTTP answer to a socket that has not switched to a raw stream, and closes it. */
function answerAndClose(
  socket: Socket,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  socket.end(
    Buffer.concat([
      Buffer.from(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\ncontent-type: ${contentType}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n`,
      ),
      Buffer.from(body),
    ]),
  );
}

function headerLines(rawHeaders: readonly string[]): string {
  let lines = "";
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines += `${rawHeaders[index]}: ${rawHeaders[index + 1]}\r\n`;
  }
  return lines;
}

/** Whether an upgrade request's body has a Content-Length the broker accepts. */
function framedBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) return false;
  const length = Number(req.headers["content-length"] ?? 0);
  return Number.isSafeInteger(length) && length >= 0 && length <= REQUEST_LIMIT_BYTES;
}

/**
 * Reads and holds what the client of an upgrade request sends after its body, starting with
 * `head`, until the daemon switches to a raw stream. Node delivers the Content-Length body on the
 * request itself and only the bytes after it here. Reading, rather than pausing the socket, lets
 * the broker see the client leave. A client that ends its side or sends more than REQUEST_LIMIT_BYTES
 * before the switch is disconnected: a Docker client sends nothing after the body until the daemon
 * answers.
 */
function holdUntilSwitch(socket: Socket, head: Buffer) {
  const chunks = [head];
  let bytes = head.length;
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    bytes += chunk.length;
    if (bytes > REQUEST_LIMIT_BYTES) socket.destroy();
  };
  const onEnd = () => socket.destroy();
  socket.on("data", onData);
  socket.on("end", onEnd);
  return {
    /** Stops holding and returns what the client sent after its body, for the raw stream. */
    release(): Buffer {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.pause();
      return Buffer.concat(chunks);
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > REQUEST_LIMIT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

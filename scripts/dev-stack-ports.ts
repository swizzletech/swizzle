import { readFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";

const HOST = "127.0.0.1";
const ENDPOINTS = ["api", "web", "localWorker"] as const;

type Endpoint = (typeof ENDPOINTS)[number];
type ServicePorts = Record<Endpoint, number>;

function forward(client: Socket, targetFile: string): void {
  let port: number;
  try {
    const [pid, target] = readFileSync(targetFile, "utf8").trim().split(" ").map(Number);
    if (
      pid === undefined ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      target === undefined ||
      !Number.isInteger(target) ||
      target < 1 ||
      target > 65535
    ) {
      client.destroy();
      return;
    }
    process.kill(pid, 0);
    port = target;
  } catch {
    client.destroy();
    return;
  }

  const upstream = connect({ host: HOST, port });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  client.once("close", () => upstream.destroy());
  client.pipe(upstream).pipe(client);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", fail);
    server.once("listening", ready);
    server.listen({ host: HOST, port });
  });
}

export async function holdPorts(directory: string, recorded?: ServicePorts) {
  const ports = { api: 0, web: 0, localWorker: 0 };
  const servers: Server[] = [];
  const targets = {
    api: path.join(directory, "api"),
    web: path.join(directory, "web"),
    localWorker: path.join(directory, "localWorker"),
  };
  const close = () => {
    for (const server of servers) server.close();
  };
  try {
    for (const name of ENDPOINTS) {
      const server = createServer((client) => forward(client, targets[name]));
      servers.push(server);
      ports[name] = await listen(server, recorded?.[name] ?? 0).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EADDRINUSE") throw error;
          return listen(server, 0);
        },
      );
    }
    return { ports, targets, close };
  } catch (error) {
    close();
    throw error;
  }
}

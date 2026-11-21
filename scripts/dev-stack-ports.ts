import { createServer, type Server } from "node:net";

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "0.0.0.0", port }, () => resolve(server));
  });
}

export async function choosePorts(recorded: readonly (number | undefined)[]): Promise<number[]> {
  const servers = await Promise.all(
    recorded.map((port) => listen(port ?? 0).catch(() => listen(0))),
  );
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

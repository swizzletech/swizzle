import { createBroker } from "./broker.js";
import { readBrokerScope } from "./policy.js";

const scope = readBrokerScope(process.env);
if (typeof scope === "string") {
  console.error(`docker-broker cannot start: ${scope}`);
  process.exit(1);
}

const server = createBroker({
  onDeny: (method, url, message) => console.error(JSON.stringify({ method, url, message })),
  scope,
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
});
server.listen(Number(process.env.PORT ?? 2375), "0.0.0.0");
process.on("SIGTERM", () => server.close(() => process.exit(0)));

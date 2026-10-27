// Entry point of the docker-broker service: the worker's only route to the Docker socket in the
// Compose stack (infra/docker/compose.yml). It reads its stack, run network and the platform's
// container maximums from the same variables the worker does and refuses to start without them.
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

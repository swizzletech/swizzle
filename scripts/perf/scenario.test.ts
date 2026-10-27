import { expect, test } from "vitest";
import { stackScenario } from "./scenario.mts";

test("resolved Compose capacity and limits are saved without credentials or project identity", () => {
  const config = {
    name: "random-project",
    services: {
      worker: {
        build: { context: "/random/checkout" },
        deploy: { replicas: 3 },
        environment: {
          WORKER_CONCURRENCY: "7",
          LOG_LEVEL: "warn",
          DATABASE_URL: "postgres://user:secret@postgres/db",
          SWIZZLE_ENCRYPTION_KEY: "secret",
          SWIZZLE_RUNNER_NETWORK: "random-project_runner-egress",
          AWS_SECRET_ACCESS_KEY: "secret",
        },
        mem_limit: 1024,
        pids_limit: 32,
      },
      postgres: { image: "postgres:test", environment: { POSTGRES_PASSWORD: "secret" } },
    },
  };
  expect(stackScenario(JSON.stringify(config))).toEqual({
    workerConcurrency: 7,
    workerReplicas: 3,
    "worker.LOG_LEVEL": "warn",
    "worker.mem_limit": 1024,
    "worker.pids_limit": 32,
    "postgres.image": "postgres:test",
  });
});

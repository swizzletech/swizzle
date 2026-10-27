// The preload node loads with `--import` before main.ts (infra/docker/Dockerfile, the dev script in
// package.json), so OpenTelemetry instruments http, fastify, pg and ioredis as main.ts imports them.
import { startTracing } from "@swizzle/core";

await startTracing("swizzle-scheduler");

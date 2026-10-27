# Enable tracing

The API, scheduler and worker can export OpenTelemetry traces to an OTLP/HTTP collector. Tracing is off until you set an endpoint. Each service then starts the Node SDK with [`startTracing`](../../packages/core/src/tracing.ts). Its preload runs with `--import` before `main.js` ([API](../../apps/api/src/tracing.ts), [scheduler](../../apps/scheduler/src/tracing.ts), [worker](../../apps/worker/src/tracing.ts)). The Dockerfile uses this preload for packaged services, and each app's dev command uses it too. The SDK patches HTTP, PostgreSQL and Valkey before the service loads them, so those libraries can export spans for requests, queries and commands. The API adds the matched Fastify route as `http.route` on the HTTP server span ([`buildServer`](../../apps/api/src/server.ts)).

## Turn it on

1. Set the base URL of your collector in `.env`. The services send traces to `<endpoint>/v1/traces`:

   ```env
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
   ```

2. Restart the API, scheduler and worker. Each logs `OpenTelemetry tracing enabled.` at startup.

In the Compose stack, the API sends outbound HTTP and traces through the control egress proxy. The local worker reaches its private API listener directly and sends traces through the configured proxy ([`controlEgressAgentOptions`](../../packages/core/src/http-egress.ts)). The proxy allows the exact hostname and port of `OTEL_EXPORTER_OTLP_ENDPOINT`, including a LAN address or `http://host.docker.internal:4318` for a collector on the Docker host ([`control-egress.mjs`](../../infra/docker/control-egress.mjs)). Sandboxed runs receive no such exception. The scheduler reaches the collector directly.

## Find a run in the traces

Each service reports under its own name: `swizzle-api`, `swizzle-scheduler` and `swizzle-worker`. The API wraps the recording of an execution's outcome in `automation.complete` with `automation.run_id`, `automation.execution` (the execution number), `worker.id` and the resulting `automation.status` ([`execution-service.ts`](../../packages/runtime/src/execution-service.ts)). The machine wraps execution in `automation.process`, carrying the run and worker IDs ([`execution-wire.ts`](../../packages/runtime/src/execution-wire.ts)).

The queue carries W3C trace context from enqueue to dispatch. The assignment carries it onward to the machine. A webhook therefore shares one trace with API orchestration, database queries, queue commands and worker execution. PostgreSQL and Valkey spans belong to the API and scheduler; workers have neither client.

## Turn it off

Leave `OTEL_EXPORTER_OTLP_ENDPOINT` empty and restart the services. The SDK then does not start.

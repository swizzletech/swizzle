# Environments

An environment scopes deployments and runtime data inside one Swizzle instance. It lets the same automation run in staging and production without sharing secrets or state. Automation folders group automations within one project and do not change runtime data.

Projects can protect the same environment name independently. Protection limits project access but does not create a separate runtime namespace. See [the security model](security-model.md) for how environment grants cap project roles.

## The dashboard offers the environments the instance lists

The dashboard's environment switch offers every entry from `GET /environments`, with the instance default first ([`registerEnvironmentRoutes`](../../apps/api/src/environment-routes.ts)). The API includes the default even when it has not been registered. The dashboard uses the browser's saved choice while the API still lists it. Otherwise, the dashboard selects the default.

## Environments scope data, not compute

A run resolves secrets from its automation's project and its environment. Connections still resolve by environment. Webhook paths are unique per environment, so two environments can serve the same path. Rollbacks, timeout grants, and notification rules also apply to one environment.

Workers run queued runs across environments because queues are named by worker profile, not environment ([`createQueueNameForProfile`](../../packages/runtime/src/runtime-requirements.ts)). A scheduler fires cron triggers only for its configured `SWIZZLE_ENVIRONMENT` ([`materializeDueCronRuns`](../../packages/runtime/src/triggers.ts)). A cron automation with no scheduler for its environment does not fire. The API judges cron next runs against the live scheduler environments ([`JudgedTriggerSummary`](../../packages/runtime/src/http-contract.ts)), so the Overview and `swizzle inspect` name the missing scheduler instead of showing a next run time. If another environment has a live scheduler, the Overview names that environment ([`buildAttention`](../../packages/db/src/dashboard-attention.ts)). `swizzle apply` warns when no live scheduler heartbeat exists for that environment ([`environment-guard.ts`](../../apps/cli/src/environment-guard.ts)).

## Services require callers to name the environment

Callers must name the environment when they use a database store or runtime operation that acts on one environment. Those calls do not choose `local` when a caller omits the name. A local `swizzle run` passes `local` explicitly ([`local-commands.ts`](../../apps/cli/src/local-commands.ts)). Requiring the name keeps a missing value from selecting a different namespace.

The API and scheduler require `SWIZZLE_ENVIRONMENT` at startup ([`readConfiguredEnvironment`](../../packages/db/src/environments.ts)). The API uses it when a request omits the `environment` parameter ([`getEnvironment`](../../apps/api/src/http-shared.ts)). The scheduler uses it to select cron triggers. Workers report their approved environment grants and accept only matching assignments.

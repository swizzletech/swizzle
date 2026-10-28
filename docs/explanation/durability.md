# The durability boundary

Swizzle is durable at the platform boundary, not inside your code. PostgreSQL stores deployments, trigger state, queued runs, attempts, retries, dead letters, logs, notification deliveries, secret metadata and artifact locators. The API and scheduler rebuild queue work from those rows. If a worker stops during an attempt, the lease expires and the server retries the run under its retry policy. Valkey and BullMQ carry work in flight. Your entrypoint is an ordinary process that can crash at any line.

The wire format of each mechanism is in the [runtime contract](../reference/runtime-contract.md). This page explains why the mechanisms look the way they do.

## Cron resumes at the next future occurrence

Cron does not replay occurrences missed while the scheduler was stopped. The scheduler advances the cursor past all due occurrences and starts only the latest one, if it is no more than 30 seconds late. That grace covers two default polling ticks. Older occurrences are recorded as missed and never become runs, regardless of `runtime.on_overlap`. The rule applies to UTC cron expressions and `trigger.every` intervals. Intervals keep their original cadence.

The scheduler advances the cursor with a PostgreSQL claim that compares the previous cursor, so two schedulers cannot claim the same trigger state. The cursor advance and its `cron_missed` audit event commit together. The event records `missedCount`, `firstMissedAt`, `lastMissedAt`, and `nextRunAt` for the trigger and environment. The automation's **Versions** tab shows it in **Change history**. A due occurrence within grace still follows the usual overlap and missing-secret checks.

## State lives in the platform, not on the worker

A run starts in a fresh scratch directory that the worker deletes when the run ends, and deployed runs execute in a read-only container. A file written there is gone on the next run. Small durable values belong in the platform state store instead.

Before each attempt, the server-side [`prepareRunExecution`](../../packages/runtime/src/run-lifecycle/execution.ts) reads the automation's state map from PostgreSQL ([`automationState`](../../packages/db/src/schema.ts)) and the runner writes it to a JSON file named by `SWIZZLE_STATE_FILE` ([`runner.ts`](../../packages/runtime/src/runner.ts), [`container-runner.ts`](../../packages/runtime/src/container-runner.ts)). Code reads that snapshot and changes state by printing `state_set` and `state_delete` events on stderr. [`applyRunEvents`](../../packages/runtime/src/run-lifecycle/events.ts) parses stderr line by line as the worker delivers each output chunk, and applies each event to PostgreSQL in order before the chunk is acknowledged, so a value set before a crash survives it.

Writing through stderr instead of an API call keeps the process contract free of credentials and network access: the run needs no token to persist state. State is per automation and environment, a single value is limited to 64 KB and the total to 5 MB. Larger or binary data belongs in the target system or object storage. The [state store](../../packages/db/src/control-plane-state.ts) admits and writes each value in one transaction. It locks the automation and environment namespace before summing stored JSON byte counts, so concurrent runs and API writes share the same total limit.

## Claims decide once across runs

The server reads the state snapshot before each attempt. Two runs that start together see the same values. A value one run sets reaches another only on its next run. "If the key is unset, act, then set it" lets both runs act. A claim checks and writes the key in PostgreSQL under the namespace lock. The SDK's `claim` suspends the run with reason `claim`. [`handleSuspendedRunExecution`](../../packages/runtime/src/run-lifecycle/suspension.ts) stores the run id if the key has no value ([`claimAutomationStateKey`](../../packages/db/src/control-plane-state.ts)). The runtime records the claim result as the step result and queues the run again. A suspend is the process's only way to ask the platform something and wait for the answer. It needs no token or network access, so a claim works in the sandbox and on a remote worker.

The stored value names the holding run, so the claim belongs to that run rather than to one attempt. A retry or resume reads its step result and keeps the claim. Every other run gets false.

## Steps make retries cheap

A retry starts the entrypoint again from the top. Without help, it repeats every call the failed attempt already made. Durable steps prevent that. The SDK prints a `step_start` event before it calls the step function, then prints a `step_result` event after the function returns. The API stores the result in [`runSteps`](../../packages/db/src/schema.ts), keyed by run and step name. An unfinished row identifies a step that is running, waiting, or stopped by a failed attempt. Before the next attempt, the worker writes completed results to `SWIZZLE_STEPS_FILE`, and the SDK helper ([`runStep`](../../packages/sdk-ts/src/index.ts), [`run_step`](../../packages/sdk-py/swizzle_sdk.py)) returns each stored value without calling its function again.

The first stored result wins. [`applyStepResultEvent`](../../packages/runtime/src/run-lifecycle/events.ts) ignores a second `step_result` for the same name, so a step cannot change its answer within a run. The limits match state: 64 KB per result, 5 MB per run. The run row counts its steps and the bytes of their results, and every step write updates both under a lock on that row ([`writeStep`](../../packages/db/src/control-plane-steps.ts)), so checking a limit reads two numbers instead of every step. A started step counts toward the 2000 steps of a run, and its result toward the 5 MB once it arrives.

A step is the unit of exactly-once, and nothing smaller is. Work inside a step that fails before its result is stored runs again on the next attempt. A step that sends an email and then crashes before it returns sends the email twice. Keep each side effect idempotent, or give it its own step.

## Waiting runs give the worker slot back

Some automations wait for hours: for a timer, a child automation, an external event or a human approval. Holding a worker process for that time would cap the platform at one waiting run per slot. Instead, the run suspends. The code prints one suspend sentinel (`{"$swizzle": {"suspend": ...}}`) on stdout and exits with code `0`.

[`handleSuspendedRunExecution`](../../packages/runtime/src/run-lifecycle/suspension.ts) records the execution as `suspended`, sets the run to `waiting`, and releases the slot. The [`runs` row](../../packages/db/src/schema.ts) stores one `wait` value discriminated by reason. The `RunWait` type requires a step key for every wait and a deadline for sleeps. Event and approval waits also carry a start time. TypeScript rejects a sleep without a deadline or an approval without a step key. The suspended execution's row keeps the reason and step key of its wait, so the read model names it as the wait the next execution resumed after. Runtime and dashboard reads use the run's current wait. Each reason resumes differently:

- The scheduler's due-wait sweep ([`resumeDueWaitingRunsWithStore`](../../packages/runtime/src/run-lifecycle/waits.ts), called from [`scheduler.ts`](../../apps/scheduler/src/scheduler.ts)) re-enqueues a sleeping run when its deadline is due.
- A child invocation creates a new run that points back at the parent step. Nesting stops at [`MAX_INVOKE_DEPTH`](../../packages/runtime/src/run-lifecycle/suspension.ts). When the child reaches `succeeded` or `dead-lettered`, the parent stores the child's result envelope as its step result and is re-enqueued. A failed child is data the parent branches on, not an exception.
- A claim resolves as soon as the runtime checks the key and records the result. It does not wait for a timer, child run, event or approval.
- An event or approval wait resumes through a posted value. Resolving it ([`resolveWaitingEventRun`](../../packages/runtime/src/run-lifecycle/waits.ts)) writes the step result and clears the wait in one transaction, then re-enqueues the run. A timeout runs through the same due-wait sweep and stores `timedOut: true`.

The resumed execution starts from the top again. Completed steps return their stored values, and the wait itself is a step whose stored value is the resume result. Suspension is therefore the step mechanism applied to time, which is why it needs no separate checkpoint format.

## A resumed segment gets a fresh retry budget

The execution number counts every start of the run's process, including resumes and retries. The attempt counts starts against `runtime.retry.max_attempts` within one segment. Each wait ends a segment, and the next execution starts at attempt 1. [`handleFailedRunExecution`](../../packages/runtime/src/run-lifecycle/failure.ts) compares the execution's attempt with the retry limit. The claim that starts an execution increments `attemptsMade`, so the dashboard can show "Running, attempt 2" during a retry. A resume does not spend a retry.

Retryable failures belong to executions; their run stays queued. Once a run finishes, a late execution cannot reopen it. Cancellation, retention and execution guards share [`RUN_STATUS_PHASE`](../../packages/db/src/run-status.ts).

Automations read the attempt as `SWIZZLE_ATTEMPT` and the execution number as `SWIZZLE_EXECUTION`. `GET /runs/:id` lists each execution with `executionNumber`, `attempt` and `resumedAfter`. `swizzle runs inspect`, `swizzle logs` and the run page show the attempt that matches the retry budget. If a run waits once and then succeeds, `GET /runs/:id` reports `attemptsMade` 1 of `attemptsMax` 2. Its two executions are numbered 1 and 2, both use attempt 1, and execution 2 names the wait in `resumedAfter`. A run can wait more times than `max_attempts` without exhausting its retry budget.

A run that slept for a day and then hits a flaky API gets the full retry budget again, instead of dying because attempts before the sleep used it up. The cost is that the total number of attempts over a run's life has no fixed bound, only the number per segment.

## What the boundary does not cover

- Side effects inside a step that fails before its result is stored repeat on retry.
- Output that the process writes after its last stored step is lost when the process crashes.
- Worker-local files, environment changes and in-memory caches do not survive an attempt.
- If Valkey loses a queued run's BullMQ job, the API checks PostgreSQL every second; the scheduler also reconciles on its tick, defaulting to every 60 seconds. Both read queued runs in pages of 100 ([`scheduler.ts`](../../apps/scheduler/src/scheduler.ts), [`reconcileQueuedRunsWithStore`](../../packages/runtime/src/run-lifecycle/enqueue.ts)).
- When leader locking is on, a scheduler also reconciles as soon as it becomes leader, including on boot or after a Valkey restart.
- The scheduler restores the original job for a run with no attempts and a resume job after suspension. For a run in retry backoff, it restores the remaining delay from the latest attempt and the remaining budget from `runs.attempts_made`. A delivery lost before start leaves that count unchanged, so the requeued job keeps the unspent attempt. Recovery preserves exponential backoff progression and does not grant extra attempts. The enqueue plan carries the total attempt offset and the consumed attempts in the current segment in job data. The server derives attempt numbers and generations under the PostgreSQL claim lock. Queue offsets retain the remaining retry delay and budget, and never grant ownership.

To use these mechanisms from an automation, follow [Write an automation](../how-to/write-an-automation.md).

## One owner per execution lease

[`dispatch-store.ts`](../../packages/db/src/dispatch-store.ts) locks the worker, execution target and lease in a fixed order. A claim checks grants, draining state, rate admission and capacity across all profiles before changing a queued run to running. It creates the attempt and increments the generation in the same transaction. Waiting for a sleeping group spends no attempt and never selects a different group.

A run can wait in the queue before a worker accepts it. PostgreSQL keeps the placement deadline across offline requeues, so a sleeping machine cannot keep a run queued forever. Waiting spends no execution attempt. A retry or resumed segment gets a fresh placement budget. That budget is separate from `runtime.timeout`.

The API fences output, state, steps and completion against that ownership. Cancellation locks the run before writing its terminal state; a completion racing it cannot overwrite that decision. Completion stores its result digest and final lifecycle state in one transaction, so a repeated report can be acknowledged after a restart.

The API renews ownership while it prepares an assignment. It does not hold ownership locks during source storage or OAuth requests. The worker renews before execution and sets a monotonic deadline from the server's remaining lease duration, less the request round trip. Machine clock differences cannot extend ownership.

A worker stops when renewal fails or its deadline arrives. The server releases expired or revoked ownership and retries within the same segment's budget. It rejects old generations even if they return later. API shutdown leaves the lease intact until expiry, so a restart does not hand out a second lease while the first worker still runs. PostgreSQL stores prepared request state with the lease, so the worker can keep its execution through an API restart. The [worker protocol](../reference/worker-protocol.md#execution-and-lease-data) describes that state and how requests use it.

External side effects remain at least once. The platform cannot undo a request that reached another system before the connection failed.

Terminal results and exhausted leases leave a durable follow-up flag. The API processes failure chains, parent resumption and notification intents from that flag in a transaction, then clears it. A restart replays unfinished follow-ups. These transactions only write durable rows. Child runs and resumed parents become BullMQ jobs through dispatch reconciliation after commit, so workers cannot receive uncommitted work and queue delays do not hold lifecycle locks. Unclaimed queue offers yield their dispatch slot, so waiting for one project or environment cannot block reachable work in the same group.

# Write deterministic tests

Write tests that pass under host load. A test waits on the state or event its next step needs, never on elapsed time. The `tests-wait-on-state` convention checks test files and both runner configurations with `just check`.

## Wait for the state the next step needs

Await the promise or event that proves the step finished. In Playwright, use a web-first assertion such as `await expect(locator).toBeVisible()`. For a state with no event, use `waitFor(signal, predicate)` from `test/support.ts`. For a PostgreSQL lock race, use `untilLockWaiters(client, count)` from `test/postgres.ts` before releasing the lock holder.

Do not write sleeps or polling loops in test bodies. Do not set per-test timeouts, retries, or short expectation timeouts that pass only on a fast machine. Assert the event or result, not how long it took.

## Drive clock behavior directly

When code reads the clock, use `vi.useFakeTimers()`, `vi.setSystemTime()`, or `page.clock`, then assert the exact value. Advance fake timers only after an event proves the code armed its timer. Await the event that proves the timer's work finished.

When a test proves a real deadline, use `heldDeadlines(ms)` from `test/support.ts` and expire the deadline after the stall is in place. Do not shorten a real deadline to make the test finish sooner. A loaded runner may reach that deadline before the test has set up the stall.

If a test must use a real deadline or interval to prove wall-clock behavior, add a reasoned exception on that line:

```ts
// conventions-allow tests-wait-on-state: the server expires this lease on its real schedule.
```

The convention checks syntax, not event order. Review fake-timer tests for code that awaits real I/O before arming a timer or inside its callback. Also review absence assertions: wait for the event that decides nothing else will happen before asserting that nothing happened.

## Keep each test's resources its own

Tests may run beside other worktrees against the same host. Give each test its own files, ports, processes, database rows, containers, and Docker images. Use `temporaryDirectory()` from `test/support.ts`, bind servers to port `0`, and use uniquely named Docker resources. Clean them up when the test ends.

When a test exercises a host resource measurement, control the measurement instead of reading the runner's current state. For disk checks, call `diskSpace(gib)` from `test/disk-space.ts`. It sets `statfsSync` in the test process and in Node child processes, so recipe tests can check low-space failures and sufficient-space paths on any runner.

The runner timeout is a hang limit, not a performance target. Keep timeouts in `vitest.config.ts` and `playwright.config.ts`. A slow test that needs more room belongs in a separate runner project with a reason for its ceiling. Fix a flaky test at the race. Do not retry it.

Sources: [`tests-wait-on-state.ts`](../../scripts/conventions/rules/tests-wait-on-state.ts), [`test/support.ts`](../../test/support.ts), [`test/postgres.ts`](../../test/postgres.ts), [`test/disk-space.ts`](../../test/disk-space.ts), [`disk-space.mjs`](../../test/fixtures/disk-space.mjs), [`vitest.config.ts`](../../vitest.config.ts), [`playwright.config.ts`](../../playwright.config.ts)

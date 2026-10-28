import { expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { testDatabase } from "../../../test/postgres.js";
import { createAutomationFixture } from "../test/platform-harness.js";

it.each(['  schedule: "0 * * * *"', "  every: 1h"])(
  "misses downtime occurrences and runs the next hour a few seconds late (%s)",
  async (schedule) => {
    const platform = await testPlatform();
    await platform.deployAutomationToPlatform({
      environment: "production",
      automationDirectory: await createAutomationFixture({
        name: "hourly",
        triggerLines: ["  type: cron", schedule],
        configLines: ["runtime:", "  on_overlap: queue"],
      }),
    });
    const trigger = await platform.getAutomationTrigger("hourly", "production");
    const firstDue = Date.parse(trigger.nextRunAt ?? "");
    const nextHour = new Date(firstDue + 5 * 3_600_000).toISOString();
    const now = new Date(firstDue + 4 * 3_600_000 + 5 * 60_000);

    expect(
      await platform.materializeDueCronRuns({ environment: "production", now, limit: 1 }),
    ).toEqual([]);
    expect(await platform.getAutomationTrigger("hourly", "production")).toMatchObject({
      nextRunAt: nextHour,
    });
    expect(await platform.listAutomationTriggerAuditEvents("hourly", "production")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: expect.objectContaining({
            eventType: "cron_missed",
            metadata: expect.objectContaining({
              missedCount: 5,
              firstMissedAt: new Date(firstDue).toISOString(),
              lastMissedAt: new Date(firstDue + 4 * 3_600_000).toISOString(),
            }),
          }),
        }),
      ]),
    );

    const runs = await platform.materializeDueCronRuns({
      environment: "production",
      now: new Date(Date.parse(nextHour) + 3_000),
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      triggerType: "cron",
      payload: expect.objectContaining({ scheduled_for: nextHour }),
    });
    expect(await platform.getAutomationTrigger("hourly", "production")).toMatchObject({
      nextRunAt: new Date(firstDue + 6 * 3_600_000).toISOString(),
    });
  },
);

it.each([
  ['  schedule: "*/10 * * * * *"', 10_000],
  ["  every: 30s", 30_000],
] as const)(
  "runs only the latest due occurrence, even inside grace (%s)",
  async (schedule, interval) => {
    const platform = await testPlatform();
    await platform.deployAutomationToPlatform({
      environment: "production",
      automationDirectory: await createAutomationFixture({
        name: "frequent",
        triggerLines: ["  type: cron", schedule],
        configLines: ["runtime:", "  on_overlap: queue"],
      }),
    });
    const trigger = await platform.getAutomationTrigger("frequent", "production");
    const firstDue = Date.parse(trigger.nextRunAt ?? "");
    const runs = await platform.materializeDueCronRuns({
      environment: "production",
      now: new Date(firstDue + 4 * interval + 3_000),
    });
    expect(runs.map((run) => run.payload)).toEqual([
      expect.objectContaining({ scheduled_for: new Date(firstDue + 4 * interval).toISOString() }),
    ]);
    expect(await platform.getAutomationTrigger("frequent", "production")).toMatchObject({
      nextRunAt: new Date(firstDue + 5 * interval).toISOString(),
    });
    const audit = await platform.listAutomationTriggerAuditEvents("frequent", "production");
    expect(audit.map((event) => event.change)).toMatchObject([
      {
        eventType: "cron_missed",
        metadata: {
          missedCount: 4,
          firstMissedAt: trigger.nextRunAt,
          lastMissedAt: new Date(firstDue + 3 * interval).toISOString(),
        },
      },
    ]);
  },
);

it.each([30_000, 30_001])("applies the grace deadline at %i ms", async (lag) => {
  const platform = await testPlatform();
  await platform.deployAutomationToPlatform({
    environment: "production",
    automationDirectory: await createAutomationFixture({
      name: "deadline",
      triggerLines: ["  type: cron", "  every: 1h"],
    }),
  });
  const trigger = await platform.getAutomationTrigger("deadline", "production");
  const firstDue = Date.parse(trigger.nextRunAt ?? "");
  const runs = await platform.materializeDueCronRuns({
    environment: "production",
    now: new Date(firstDue + lag),
  });
  expect(runs.map((run) => run.payload)).toEqual(
    lag === 30_000 ? [expect.objectContaining({ scheduled_for: trigger.nextRunAt })] : [],
  );
  expect(await platform.getAutomationTrigger("deadline", "production")).toMatchObject({
    nextRunAt: new Date(firstDue + 3_600_000).toISOString(),
  });
  const audit = await platform.listAutomationTriggerAuditEvents("deadline", "production");
  expect(audit.map((event) => event.change)).toMatchObject(
    lag === 30_000 ? [] : [{ eventType: "cron_missed", metadata: { missedCount: 1 } }],
  );
});

it("claims a backlog once across schedulers and leaves the other environment alone", async () => {
  const platform = await testPlatform();
  const automationDirectory = await createAutomationFixture({
    name: "shared-hourly",
    triggerLines: ["  type: cron", '  schedule: "0 * * * *"'],
    configLines: ["runtime:", "  on_overlap: queue"],
  });
  for (const environment of ["production", "staging"]) {
    await platform.deployAutomationToPlatform({ environment, automationDirectory });
  }
  const staging = await platform.getAutomationTrigger("shared-hourly", "staging");
  const trigger = await platform.getAutomationTrigger("shared-hourly", "production");
  const firstDue = Date.parse(trigger.nextRunAt ?? "");
  let releaseReaders = () => {};
  const bothRead = new Promise<void>((resolve) => {
    releaseReaders = resolve;
  });
  const readDue = platform.store.getDueCronTriggers.bind(platform.store);
  let readers = 0;
  vi.spyOn(platform.store, "getDueCronTriggers").mockImplementation(async (...args) => {
    const due = await readDue(...args);
    if (++readers === 2) releaseReaders();
    await bothRead;
    return due;
  });
  const runs = (
    await Promise.all(
      [1, 2].map(() =>
        platform.materializeDueCronRuns({
          environment: "production",
          now: new Date(firstDue + 4 * 3_600_000 + 3_000),
        }),
      ),
    )
  ).flat();
  expect(runs.map((run) => run.payload)).toEqual([
    expect.objectContaining({ scheduled_for: new Date(firstDue + 4 * 3_600_000).toISOString() }),
  ]);
  expect(await platform.getAutomationTrigger("shared-hourly", "production")).toMatchObject({
    nextRunAt: new Date(firstDue + 5 * 3_600_000).toISOString(),
  });
  expect(await platform.getAutomationTrigger("shared-hourly", "staging")).toEqual(staging);
  expect(
    (await platform.listAutomationTriggerAuditEvents("shared-hourly", "production")).map(
      (event) => event.change,
    ),
  ).toMatchObject([{ eventType: "cron_missed", metadata: { missedCount: 4 } }]);
});

it("keeps the cursor retryable when recording the missed audit fails", async () => {
  const platform = await testPlatform();
  await platform.deployAutomationToPlatform({
    environment: "production",
    automationDirectory: await createAutomationFixture({
      name: "audit-failure",
      triggerLines: ["  type: cron", "  every: 1h"],
    }),
  });
  const trigger = await platform.getAutomationTrigger("audit-failure", "production");
  const firstDue = Date.parse(trigger.nextRunAt ?? "");
  const options = {
    environment: "production",
    now: new Date(firstDue + 4 * 3_600_000 + 5 * 60_000),
  };
  await testDatabase().pool.query(`ALTER TABLE audit_events ADD CONSTRAINT reject_missed
    CHECK ((change->>'eventType') IS DISTINCT FROM 'cron_missed')`);
  try {
    await expect(platform.materializeDueCronRuns(options)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23514", constraint: "reject_missed" }),
    });
    expect(await platform.getAutomationTrigger("audit-failure", "production")).toMatchObject({
      nextRunAt: trigger.nextRunAt,
    });
  } finally {
    await testDatabase().pool.query("ALTER TABLE audit_events DROP CONSTRAINT reject_missed");
  }
  expect(await platform.materializeDueCronRuns(options)).toEqual([]);
  expect(await platform.getAutomationTrigger("audit-failure", "production")).toMatchObject({
    nextRunAt: new Date(firstDue + 5 * 3_600_000).toISOString(),
  });
  expect(
    (await platform.listAutomationTriggerAuditEvents("audit-failure", "production")).map(
      (event) => event.change,
    ),
  ).toMatchObject([{ eventType: "cron_missed", metadata: { missedCount: 5 } }]);
});

it.each([7_200, 72_000])(
  "lets the event loop progress while counting %i missed second-level occurrences",
  async (backlogSeconds) => {
    const platform = await testPlatform();
    await platform.deployAutomationToPlatform({
      environment: "production",
      automationDirectory: await createAutomationFixture({
        name: "second-level",
        triggerLines: ["  type: cron", '  schedule: "* * * * * *"'],
      }),
    });
    const trigger = await platform.getAutomationTrigger("second-level", "production");
    const firstDue = Date.parse(trigger.nextRunAt ?? "");
    const progress: string[] = [];
    const readDue = platform.store.getDueCronTriggers.bind(platform.store);
    vi.spyOn(platform.store, "getDueCronTriggers").mockImplementation(async (...args) => {
      const due = await readDue(...args);
      setImmediate(() => {
        progress.push("first callback");
        setImmediate(() => progress.push("second callback"));
      });
      return due;
    });
    const claim = platform.store.advanceCronTriggerCursor.bind(platform.store);
    vi.spyOn(platform.store, "advanceCronTriggerCursor").mockImplementation(async (input) => {
      expect(progress).toEqual(["first callback", "second callback"]);
      return await claim(input);
    });

    const runs = await platform.materializeDueCronRuns({
      environment: "production",
      now: new Date(firstDue + backlogSeconds * 1_000 + 500),
    });
    expect(runs.map((run) => run.payload)).toEqual([
      expect.objectContaining({
        scheduled_for: new Date(firstDue + backlogSeconds * 1_000).toISOString(),
      }),
    ]);
    expect(await platform.getAutomationTrigger("second-level", "production")).toMatchObject({
      nextRunAt: new Date(firstDue + (backlogSeconds + 1) * 1_000).toISOString(),
    });
    expect(
      (await platform.listAutomationTriggerAuditEvents("second-level", "production")).map(
        (event) => event.change,
      ),
    ).toMatchObject([
      {
        eventType: "cron_missed",
        metadata: {
          missedCount: backlogSeconds,
          firstMissedAt: trigger.nextRunAt,
          lastMissedAt: new Date(firstDue + (backlogSeconds - 1) * 1_000).toISOString(),
        },
      },
    ]);
  },
);

import type { Overview, RunListItem } from "../../src/lib/api";
import { DEFAULT_PROJECT, PROJECT_ID } from "./projects";
import type { MockRoute } from "./route";
import { ago, MINUTE } from "./route";
import type { MockState } from "./state";

type TimetableRow = Overview["timetable"]["rows"][number];
type RunOutcome = Pick<RunListItem, "automationSlug" | "finishedAt" | "queuedAt" | "state">;

const HOUR = 60 * MINUTE;

export function timetableRow(
  automationSlug: string,
  cells: Readonly<Record<number, TimetableRow["hours"][number]>>,
  deployments: TimetableRow["deployments"] = [],
): TimetableRow {
  return {
    automationSlug,
    deployments,
    hours: Array.from({ length: 24 }, (_, hour) => cells[hour] ?? {}),
  };
}

export function withRunOutcome(overview: Overview, run: RunOutcome): Overview {
  const { timetable, last24h, lastFailureAt } = overview;
  const { automationSlug, finishedAt, queuedAt, state } = run;
  const hour = Math.floor((Date.parse(queuedAt) - Date.parse(timetable.from)) / HOUR);
  const rows = [...timetable.rows];
  const index = rows.findIndex((row) => row.automationSlug === automationSlug);
  const row = rows[index] ?? timetableRow(automationSlug, {});
  const hours = [...row.hours];
  const cell = hours[hour];
  if (cell === undefined) throw new Error("Run is outside the fixture timetable.");
  hours[hour] = { ...cell, [state]: (cell[state] ?? 0) + 1 };
  rows[index < 0 ? rows.length : index] = { ...row, hours };

  const outcomeAt = finishedAt ?? queuedAt;
  const isFailure = state === "failed" || state === "dead-lettered";
  const isLatest = lastFailureAt === null || Date.parse(outcomeAt) > Date.parse(lastFailureAt);
  return {
    ...overview,
    last24h: { ...last24h, [state]: last24h[state] + 1 },
    lastFailureAt: isFailure && isLatest ? outcomeAt : lastFailureAt,
    timetable: { ...timetable, rows },
  };
}

export function emptyOverview(): Overview {
  const from = new Date(Date.now() - 23 * HOUR);
  from.setMinutes(0, 0, 0);
  return {
    complete: true,
    deploy: null,
    environment: "staging",
    last24h: {
      cancelled: 0,
      "dead-lettered": 0,
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
      waiting: 0,
    },
    last24hFrom: from.toISOString(),
    lastFailureAt: null,
    needsYou: [],
    recentChanges: [],
    timetable: { from: from.toISOString(), rows: [] },
  };
}

export function seedOverview(failed: RunListItem, waiting: RunListItem): Overview {
  const ref = (slug: string) => ({ automationName: slug, automationSlug: slug });
  const empty = emptyOverview();
  const deployedAt = ago(6 * MINUTE);
  return {
    ...empty,
    last24h: { ...empty.last24h, "dead-lettered": 1, running: 1, succeeded: 1, waiting: 1 },
    lastFailureAt: failed.finishedAt,
    timetable: {
      ...empty.timetable,
      rows: [
        timetableRow("verify-probe", { 23: { "dead-lettered": 1, succeeded: 1, waiting: 1 } }, [
          { at: deployedAt, version: "1.1.0" },
        ]),
        timetableRow("verify-ticker", { 23: { running: 1 } }),
      ],
    },
    needsYou: [
      {
        assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
        automation: ref("verify-probe"),
        details: { message: "Refund 120 € for order 4411?" },
        kind: "approval",
        runId: waiting.runId,
        stepKey: "gate",
        waitUntil: null,
        waitingSince: waiting.queuedAt,
      },
      {
        automation: ref("verify-probe"),
        errorCode: failed.errorCode,
        errorMessage: failed.errorMessage,
        failedRuns: 1,
        kind: "failing",
        lastFailedAt: failed.queuedAt,
        lastFailedRunId: failed.runId,
        lastFailedTriggerType: failed.triggerType,
        recentRuns: 3,
      },
      {
        kind: "missing-secret",
        project: DEFAULT_PROJECT,
        secretName: "VERIFY_SECRET",
        state: "missing",
        usedBy: [ref("verify-vault")],
      },
    ],
    recentChanges: [
      {
        id: "event-1",
        occurredAt: deployedAt,
        actor: { kind: "system" },
        action: "deploy",
        params: {},
        privileged: false,
        status: null,
        details: null,
        requestId: "system",
        target: {
          automationId: "id-verify-probe",
          automationSlug: "verify-probe",
          environment: "staging",
          projectId: PROJECT_ID,
          runId: null,
        },
        automationName: "verify-probe",
        automationSlug: "verify-probe",
        change: {
          kind: "deployment",
          automationId: "id-verify-probe",
          automationSlug: "verify-probe",
          deploymentId: "deployment-verify-probe",
          diff: null,
          environment: "staging",
          eventType: "deploy",
          metadata: {},
          previousDeploymentId: "deployment-old",
          previousSourceHash: "0000",
          previousVersion: "1.0.0",
          projectId: PROJECT_ID,
          sourceHash: "8f1c2a77d3e94b10",
          version: "1.1.0",
        },
      },
    ],
  };
}

export function overview({ is, json }: MockRoute, state: MockState) {
  if (is("GET", /^\/dashboard\/overview$/u)) return json(state.overview);
  return undefined;
}

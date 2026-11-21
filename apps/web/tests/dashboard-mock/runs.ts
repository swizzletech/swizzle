import type { RunDetail, RunListItem, RunStep, RunsResponse } from "../../src/lib/api";
import { PROJECT_ID } from "./projects";
import type { MockRoute } from "./route";
import { ago, MINUTE } from "./route";
import type { MockState } from "./state";

function run(
  overrides: Partial<RunListItem> & Pick<RunListItem, "automationSlug" | "runId" | "status">,
): RunListItem {
  return {
    approval: null,
    attemptsMade: 1,
    attemptsMax: 2,
    automationId: `id-${overrides.automationSlug}`,
    automationName: overrides.automationSlug,
    chainOriginRunId: null,
    chainSourceRunIds: [],
    childRunCount: 0,
    deadLetterReason: null,
    deploymentId: "deployment-1",
    environment: "staging",
    errorClassification: null,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    parentRunId: null,
    parentStepKey: null,
    projectId: PROJECT_ID,
    queuedAt: ago(5 * MINUTE),
    startedAt: ago(5 * MINUTE),
    state: overrides.status,
    triggerType: "webhook",
    version: "1.1.0",
    versionId: "version-1",
    wait: null,

    ...overrides,
  };
}

function detail(item: RunListItem, extra: Partial<RunDetail> = {}): RunDetail {
  return {
    ...item,
    approval:
      item.approval === null ? null : { ...item.approval, may: { decide: true, reassign: true } },
    executions: [],
    payload: { order: 4411 },
    placement: null,
    refusals: { cancel: null, edit: null, runAgain: null },
    result: null,
    stderr: "",
    stdout: "",
    ...extra,
  } as unknown as RunDetail;
}

export const FAILED_RUN_ID = "4f66e011-aaaa-4bbb-8ccc-000000000001";
export const APPROVAL_RUN_ID = "7c1e02aa-aaaa-4bbb-8ccc-000000000002";
const RUNNING_RUN_ID = "a1b2c3d4-aaaa-4bbb-8ccc-000000000003";
export const OK_RUN_ID = "2c6c0c77-aaaa-4bbb-8ccc-000000000004";

const PROBE = "verify-probe";
const ALL_RUNS = "limit=100";
const PROBE_RUNS = "automation=verify-probe&limit=100";
const PROBE_PLAY_RUNS = "automation=verify-probe&limit=25";

function runPage(
  runs: RunsResponse["runs"],
  filters: Partial<RunsResponse["filters"]> = {},
  nextCursor: string | null = null,
): RunsResponse {
  return {
    environment: "staging",
    filters: {
      automationSlug: null,
      limit: 100,
      states: [],
      statuses: [],
      triggerType: null,
      ...filters,
    },
    nextCursor,
    runs,
  };
}

export function emptyRunLists(): Map<string, RunsResponse> {
  return new Map([
    [ALL_RUNS, runPage([])],
    ["limit=50&parentRunId=", runPage([], { limit: 50 })],
  ]);
}

export function allRunPage(state: MockState): RunsResponse {
  const page = state.runLists.get(ALL_RUNS);
  if (page === undefined) throw new Error("Missing All runs fixture.");
  return page;
}

export function setAllRunPage(state: MockState, rows: RunsResponse["runs"]): void {
  state.runLists.set(ALL_RUNS, { ...allRunPage(state), runs: rows });
}

export function setRunPages(
  state: MockState,
  rows: RunsResponse["runs"],
  automationSlug: typeof PROBE | null = null,
): void {
  const query = new URLSearchParams(automationSlug === null ? ALL_RUNS : PROBE_RUNS);
  for (let from = 0; from < rows.length; from += 100) {
    const to = from + 100;
    if (from > 0) query.set("cursor", String(from));
    query.sort();
    state.runLists.set(
      query.toString(),
      runPage(rows.slice(from, to), { automationSlug }, to < rows.length ? String(to) : null),
    );
  }
}

export function addProbeRuns(state: MockState, added: RunsResponse["runs"]): void {
  const probe = state.runLists.get(PROBE_RUNS);
  if (probe === undefined) throw new Error("Missing verify-probe fixture.");
  const rows = [...probe.runs, ...added];
  setRunPages(state, rows, PROBE);
  state.runLists.set(
    PROBE_PLAY_RUNS,
    runPage(
      rows.slice(0, 25),
      { automationSlug: PROBE, limit: 25 },
      rows.length > 25 ? "25" : null,
    ),
  );
}

export function addOlderRuns(state: MockState, count: number): RunsResponse["runs"] {
  const added = Array.from({ length: count }, (_, index) => {
    const failed = index % 7 === 0;
    const queuedAt = ago((index + 1) * 60 * MINUTE);
    const older = run({
      automationName: "verify-probe",
      automationSlug: "verify-probe",
      finishedAt: queuedAt,
      queuedAt,
      runId: `70000000-aaaa-4bbb-8ccc-${String(index).padStart(12, "0")}`,
      startedAt: queuedAt,
      status: failed ? "failed" : "succeeded",
    });
    state.runDetails.set(older.runId, detail(older));
    return older;
  });
  const rows = [...allRunPage(state).runs, ...added];
  setRunPages(state, rows);
  addProbeRuns(state, added);
  return rows;
}

function probeSteps(run: RunListItem, scenario: "waiting" | "completed"): readonly RunStep[] {
  const startedAt = run.startedAt ?? run.queuedAt;
  const at = (ms: number) => new Date(Date.parse(startedAt) + ms).toISOString();
  const step = (
    stepKey: string,
    from: number,
    to: number,
    approval: RunStep["approval"] = null,
  ): RunStep => ({
    approval,
    attempt: 1,
    executionNumber: 1,
    createdAt: at(from),
    finishedAt: at(to),
    startedAt: at(from),
    stepKey,
    updatedAt: at(to),
    value: null,
  });
  const fetch = step("fetch", 20, 400);
  if (scenario === "waiting") return [fetch];

  const decided: RunStep["approval"] = {
    approved: true,
    assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
    comment: "Looks right",
    decidedAt: at(5_000),
    decidedBy: { kind: "person", label: "anna@example.com", userId: "user-anna" },
    timedOut: false,
  };
  return [fetch, step("gate", 400, 5_000, decided), step("notify", 5_000, 5_300)];
}

export function seedRuns() {
  const failed = run({
    attemptsMade: 2,
    automationSlug: "verify-probe",
    deadLetterReason: "retries-exhausted",
    errorCode: "PROCESS_EXIT_NON_ZERO",
    errorMessage: "Automation exited with code 1.",
    finishedAt: ago(4 * MINUTE - 2_000),
    queuedAt: ago(4 * MINUTE),
    runId: FAILED_RUN_ID,
    startedAt: ago(4 * MINUTE),
    status: "dead-lettered",
  });
  const waiting = run({
    approval: {
      assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
      details: { message: "Refund 120 € for order 4411?" },
      stepKey: "gate",
    },
    automationSlug: "verify-probe",
    queuedAt: ago(12 * MINUTE),
    runId: APPROVAL_RUN_ID,
    status: "waiting",
    wait: {
      stepKey: "gate",
      reason: "approval",
      assignee: { kind: "user", label: "anna@example.com", userId: "user-anna" },
      details: { message: "Refund 120 € for order 4411?" },
      until: null,
      startedAt: ago(12 * MINUTE),
    },
  });
  const ok = run({
    automationSlug: "verify-probe",
    finishedAt: ago(18 * MINUTE - 400),
    queuedAt: ago(18 * MINUTE),
    runId: OK_RUN_ID,
    startedAt: ago(18 * MINUTE),
    status: "succeeded",
  });
  const running = run({
    automationSlug: "verify-ticker",
    queuedAt: ago(10_000),
    runId: RUNNING_RUN_ID,
    status: "running",
    triggerType: "cron",
  });
  const probe = [failed, waiting, ok];
  const runLists = emptyRunLists();
  runLists.set(ALL_RUNS, runPage([running, ...probe]));
  runLists.set(PROBE_RUNS, runPage(probe, { automationSlug: PROBE }));
  runLists.set(PROBE_PLAY_RUNS, runPage(probe, { automationSlug: PROBE, limit: 25 }));
  runLists.set(
    "limit=100&state=failed%2Cdead-lettered",
    runPage([failed], { states: ["failed", "dead-lettered"] }),
  );
  runLists.set(
    "limit=100&state=queued%2Crunning",
    runPage([running], { states: ["queued", "running"] }),
  );
  runLists.set(
    "automation=nothing&limit=100&state=queued%2Crunning",
    runPage([], { automationSlug: "nothing", states: ["queued", "running"] }),
  );
  return {
    failed,
    ok,
    running,
    waiting,
    runLists,
    runSteps: new Map([
      [APPROVAL_RUN_ID, probeSteps(waiting, "waiting")],
      [OK_RUN_ID, probeSteps(ok, "completed")],
    ]),
    runDetails: new Map([
      [
        FAILED_RUN_ID,
        detail(failed, {
          stderr:
            "checking payload for order 4411\nTypeError: Cannot read properties of undefined (reading 'id')\n",
        }),
      ],
      [APPROVAL_RUN_ID, detail(waiting)],
      [OK_RUN_ID, detail(ok, { result: { refunded: false } })],
      [RUNNING_RUN_ID, detail(running)],
    ]),
  };
}

export function runs({ apiError, is, json, param, route, search }: MockRoute, state: MockState) {
  if (is("GET", /^\/dashboard\/runs$/u)) {
    const query = new URLSearchParams(search);
    query.delete("environment");
    if (query.has("parentRunId")) query.set("parentRunId", "");
    query.sort();
    const response = state.runLists.get(query.toString());
    if (response !== undefined) return json(response);
    return undefined;
  }
  if (is("GET", /^\/dashboard\/runs\/[^/]+$/u)) {
    const found = state.runDetails.get(param(/^\/dashboard\/runs\/([^/]+)$/u));
    return found === undefined ? apiError("RUN_NOT_FOUND", 404, "No such run.") : json(found);
  }
  if (is("GET", /^\/dashboard\/runs\/[^/]+\/steps$/u)) {
    const runId = param(/^\/dashboard\/runs\/([^/]+)\//u);
    return json(state.runSteps.get(runId) ?? []);
  }
  if (is("GET", /^\/runs\/[^/]+\/diagnosis$/u)) {
    return json({
      likelyCause: {
        code: "AUTOMATION_CRASHED",
        summary: "Automation process exited non-zero. Inspect stderr for the root cause.",
      },
      suggestedFixes: [],
    });
  }
  if (is("GET", /^\/runs\/[^/]+\/logs\/stream$/u)) {
    return route.fulfill({
      body: 'event: status\ndata: {"status":"running","terminal":false}\n\n',
      contentType: "text/event-stream",
    });
  }
  if (is("PUT", /^\/runs\/[^/]+\/approvals\/[^/]+\/assignee$/u)) {
    const runId = param(/^\/runs\/([^/]+)\//u);
    const assignee = { kind: "team" as const, label: "Finance", teamId: "team-finance" };
    const run = state.runDetails.get(runId);
    if (run?.approval)
      state.runDetails.set(runId, { ...run, approval: { ...run.approval, assignee } });
    return json({ assignee, runId, stepKey: "gate" });
  }
  if (is("POST", /^\/runs\/[^/]+\/approvals\/[^/]+$/u)) {
    const runId = param(/^\/runs\/([^/]+)\//u);
    state.overview = {
      ...state.overview,
      needsYou: state.overview.needsYou.filter(
        (item) => !(item.kind === "approval" && item.runId === runId),
      ),
    };
    const resumed = {
      approval: null,
      state: "queued" as const,
      status: "queued" as const,
      wait: null,
    };
    setAllRunPage(
      state,
      allRunPage(state).runs.map((item) => (item.runId === runId ? { ...item, ...resumed } : item)),
    );
    const run = state.runDetails.get(runId);
    if (run !== undefined) state.runDetails.set(runId, { ...run, ...resumed });
    return json({ resumed: true, runId });
  }
  return undefined;
}

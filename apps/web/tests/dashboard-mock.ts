import type { Page } from "@playwright/test";
import { auth, type MockAuthOptions } from "./dashboard-mock/auth";
import { automations, NO_REFUSALS, seedAutomations } from "./dashboard-mock/automations";
import { connections } from "./dashboard-mock/connections";
import { environments } from "./dashboard-mock/environments";
import { folders } from "./dashboard-mock/folders";
import { health } from "./dashboard-mock/health";
import { notifications } from "./dashboard-mock/notifications";
import { operations } from "./dashboard-mock/operations";
import { emptyOverview, overview, seedOverview } from "./dashboard-mock/overview";
import { DEFAULT_PROJECT, projects } from "./dashboard-mock/projects";
import { readRoute } from "./dashboard-mock/route";
import { emptyRunLists, runs, seedRuns } from "./dashboard-mock/runs";
import { secrets } from "./dashboard-mock/secrets";
import type { MockState } from "./dashboard-mock/state";
import { tokens } from "./dashboard-mock/tokens";

export type { MockTwoFactor } from "./dashboard-mock/auth";
export { timetableRow, withRunOutcome } from "./dashboard-mock/overview";
export { PROJECT_ID } from "./dashboard-mock/projects";
export { ago, MINUTE } from "./dashboard-mock/route";
export {
  APPROVAL_RUN_ID,
  addOlderRuns,
  addProbeRuns,
  allRunPage,
  FAILED_RUN_ID,
  OK_RUN_ID,
  setAllRunPage,
  setRunPages,
} from "./dashboard-mock/runs";
export type { MockState } from "./dashboard-mock/state";

const resources = [
  environments,
  overview,
  automations,
  folders,
  runs,
  projects,
  secrets,
  connections,
  tokens,
  notifications,
  operations,
  health,
];

export async function mockDashboardApi(
  page: Page,
  state: MockState,
  options: MockAuthOptions = {},
) {
  const session = auth(options);
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const request = readRoute(route);
      const { body, method, pathname, search, apiError, json } = request;
      state.requests.push({ body, method, pathname, search });

      const authentication = session.handle(request);
      if (authentication !== undefined) return authentication;
      if (!session.authenticated) return apiError("UNAUTHORIZED", 401, "Sign in.");

      for (const resource of resources) {
        const response = resource(request, state);
        if (response !== undefined) return response;
      }
      state.unhandled.push(`${method} ${pathname}`);
      return json({ error: "NOT_MOCKED", message: `${method} ${pathname} is not mocked.` }, 404);
    },
  );
}

export function seededState(): MockState {
  const seed = seedRuns();
  return {
    ...emptyState(),
    overview: seedOverview(seed.failed, seed.waiting),
    automations: seedAutomations(seed),
    runLists: seed.runLists,
    runSteps: seed.runSteps,
    runDetails: seed.runDetails,
  };
}

export function emptyState(): MockState {
  return {
    automations: [],
    connections: [],
    overview: emptyOverview(),
    automationRefusals: NO_REFUSALS,
    folders: { create: null, folders: [] },
    projects: [DEFAULT_PROJECT],
    requests: [],
    runDetails: new Map(),
    runLists: emptyRunLists(),
    runSteps: new Map(),
    secrets: [],
    tokens: [],
    unhandled: [],
  };
}

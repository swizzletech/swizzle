// The dashboard's API client: every resource's calls, bound to the environment in view.
// dashboard-client.tsx creates one per environment; pages reach it through useDashboardClient.

import { accountCalls } from "./account";
import { automationsCalls } from "./automations";
import { credentialsCalls } from "./credentials";
import { notificationsCalls } from "./notifications";
import { operationsCalls } from "./operations";
import { peopleCalls } from "./people";
import { projectsCalls } from "./projects";
import { runsCalls } from "./runs";
import { serviceAccountsCalls } from "./service-accounts";
import { tokensCalls } from "./tokens";
import { workersCalls } from "./workers";

export interface ApiRequestContext {
  readonly environment: string;
}

export function createDashboardApiClient({ environment }: ApiRequestContext) {
  return {
    ...accountCalls(),
    ...tokensCalls(),
    ...peopleCalls(environment),
    ...projectsCalls(),
    ...serviceAccountsCalls(),
    ...workersCalls(),
    ...operationsCalls(environment),
    ...notificationsCalls(environment),
    ...automationsCalls(environment),
    ...runsCalls(environment),
    ...credentialsCalls(environment),
  };
}

export type DashboardApiClient = ReturnType<typeof createDashboardApiClient>;

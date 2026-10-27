import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

import type { InstanceEnvironments } from "./api";
import { createDashboardApiClient, type DashboardApiClient } from "./api/client";

// The dashboard works in two layers. DashboardSessionProvider wraps the app and holds what signing
// in needs; AppShell signs the owner in, asks the instance which environments it lists, and only
// then mounts DashboardClientProvider, so every page reads a known environment.

const ENVIRONMENT_STORAGE_KEY = "swizzle.dashboard.environment";

interface DashboardSessionContextValue {
  /** Bumps on sign-in and sign-out, so queries keyed on it refetch for the new session. */
  readonly authRevision: number;
  readonly refreshAuth: () => void;
}

export interface DashboardClientContextValue extends DashboardSessionContextValue {
  readonly api: DashboardApiClient;
  readonly environment: string;
  /** The environments the switch offers. */
  readonly environments: readonly string[];
  readonly queryScope: readonly [string, number];
  readonly setEnvironment: (environment: string) => void;
}

const DashboardSessionContext = createContext<DashboardSessionContextValue | null>(null);
const DashboardClientContext = createContext<DashboardClientContextValue | null>(null);

export function DashboardSessionProvider({ children }: { readonly children: ReactNode }) {
  const [authRevision, setAuthRevision] = useState(0);
  const value = useMemo<DashboardSessionContextValue>(
    () => ({ authRevision, refreshAuth: () => setAuthRevision((current) => current + 1) }),
    [authRevision],
  );

  return (
    <DashboardSessionContext.Provider value={value}>{children}</DashboardSessionContext.Provider>
  );
}

export function useDashboardSession(): DashboardSessionContextValue {
  const context = useContext(DashboardSessionContext);
  if (context === null) {
    throw new Error("useDashboardSession must be used inside DashboardSessionProvider.");
  }
  return context;
}

/**
 * Opens on the environment the owner last chose in this browser while the instance still lists
 * it, else on the instance's default. The switch offers every environment the instance lists.
 */
export function DashboardClientProvider({
  children,
  instanceEnvironments,
}: {
  readonly children: ReactNode;
  readonly instanceEnvironments: InstanceEnvironments;
}) {
  const session = useDashboardSession();
  const { defaultEnvironment, names: environments } = instanceEnvironments;
  const [chosenEnvironment, setChosenEnvironment] = useState(() =>
    readStorage(ENVIRONMENT_STORAGE_KEY),
  );
  const environment =
    chosenEnvironment !== null && environments.includes(chosenEnvironment)
      ? chosenEnvironment
      : defaultEnvironment;
  const api = useMemo(() => createDashboardApiClient({ environment }), [environment]);

  const value = useMemo<DashboardClientContextValue>(
    () => ({
      ...session,
      api,
      environment,
      environments,
      queryScope: [environment, session.authRevision],
      setEnvironment: (nextEnvironment: string) => {
        setChosenEnvironment(nextEnvironment);
        writeStorage(ENVIRONMENT_STORAGE_KEY, nextEnvironment);
      },
    }),
    [api, environment, environments, session],
  );

  return (
    <DashboardClientContext.Provider value={value}>{children}</DashboardClientContext.Provider>
  );
}

export function useDashboardClient(): DashboardClientContextValue {
  const context = useContext(DashboardClientContext);
  if (context === null) {
    throw new Error("useDashboardClient must be used inside DashboardClientProvider.");
  }
  return context;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Dashboard still works without persistent browser storage.
  }
}

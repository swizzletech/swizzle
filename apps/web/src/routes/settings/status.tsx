// Settings › Status, for instance owners and admins: the version, the environments and whether
// workers, scheduler and cleanup run.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Chip, ErrorNote, Skeleton } from "../../components/ui";
import { useDashboardClient } from "../../lib/dashboard-client";
import { Section } from "./section";

export function Status() {
  const { api, environment, environments } = useDashboardClient();
  const health = useQuery({
    queryFn: () => api.getHealth(),
    queryKey: ["health"],
  });
  return (
    <Section intro="Whether the platform runs. Problems also show on the Overview." title="Status">
      <div className="card rows overflow-hidden" data-testid="status">
        <StatusFact label="Version">
          <span className="mono">{health.data?.version ?? "…"}</span>
        </StatusFact>
        <StatusFact label="Environments">
          {environments.map((name) => (
            <span className="mr-2" key={name}>
              <span className="mono">{name}</span>
              {name === environment ? <span className="t-faint"> (shown)</span> : null}
            </span>
          ))}
        </StatusFact>
        <PlatformState />
      </div>
    </Section>
  );
}

/** Workers, scheduler and cleanup. */
function PlatformState() {
  const { api, queryScope } = useDashboardClient();
  const operations = useQuery({
    queryFn: () => api.getOperationsSummary(),
    queryKey: ["operations", ...queryScope],
    refetchInterval: 30_000,
  });
  if (operations.isError) {
    return (
      <div className="p-4">
        <ErrorNote error={operations.error} title="The platform state could not be loaded." />
      </div>
    );
  }
  if (operations.data === undefined) {
    return <Skeleton label="Loading the platform state" lines={2} />;
  }
  const alive = (service: string) =>
    operations.data.services.summary.find((entry) => entry.service === service)?.alive ?? 0;
  const workers = operations.data.onlineWorkers;
  return (
    <>
      <StatusFact label="Workers">
        {workers === 0 ? (
          <Chip tone="fail">No worker is running</Chip>
        ) : (
          `${workers} ${workers === 1 ? "worker" : "workers"} running`
        )}
      </StatusFact>
      <StatusFact label="Scheduler">
        {alive("scheduler") === 0 ? <Chip tone="fail">Not running</Chip> : "Running"}
      </StatusFact>
      <StatusFact label="Cleanup">{CLEANUP_IN_WORDS[operations.data.maintenance.state]}</StatusFact>
    </>
  );
}

const CLEANUP_IN_WORDS = {
  degraded: "Failing or late",
  healthy: "Runs on schedule",
  missing: "Has not run yet",
} as const;

function StatusFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="setting">
      <span className="t-meta">{props.label}</span>
      <span className="text-right">{props.children}</span>
    </div>
  );
}

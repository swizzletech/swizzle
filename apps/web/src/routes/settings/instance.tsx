// Settings › Instance (#instance): the version, environments and the platform's state.

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Chip, ErrorNote, Skeleton } from "../../components/ui";
import { useDashboardClient } from "../../lib/dashboard-client";
import { SECTION_DATA, Section } from "./section";

export function Instance({ operator }: { readonly operator: boolean }) {
  const { api, environment, environments } = useDashboardClient();
  const health = useQuery({
    meta: SECTION_DATA,
    queryFn: () => api.getHealth(),
    queryKey: ["health"],
  });
  return (
    <Section
      id="instance"
      intro="Details for running the platform. Problems also show on the Overview."
      title="Instance"
    >
      <div className="card rows overflow-hidden" data-testid="instance">
        <InstanceFact label="Version">
          <span className="mono">{health.data?.version ?? "…"}</span>
        </InstanceFact>
        <InstanceFact label="Environments">
          {environments.map((name) => (
            <span className="mr-2" key={name}>
              <span className="mono">{name}</span>
              {name === environment ? <span className="t-faint"> (shown)</span> : null}
            </span>
          ))}
        </InstanceFact>
        {operator ? (
          <PlatformState />
        ) : (
          <InstanceFact label="Workers, scheduler, cleanup">
            <span className="t-faint">Shown to instance owners and admins</span>
          </InstanceFact>
        )}
      </div>
    </Section>
  );
}

/** Workers, scheduler and cleanup, which only an owner or admin may read. */
function PlatformState() {
  const { api, queryScope } = useDashboardClient();
  const operations = useQuery({
    meta: SECTION_DATA,
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
      <InstanceFact label="Workers">
        {workers === 0 ? (
          <Chip tone="fail">No worker is running</Chip>
        ) : (
          `${workers} ${workers === 1 ? "worker" : "workers"} running`
        )}
      </InstanceFact>
      <InstanceFact label="Scheduler">
        {alive("scheduler") === 0 ? <Chip tone="fail">Not running</Chip> : "Running"}
      </InstanceFact>
      <InstanceFact label="Cleanup">
        {CLEANUP_IN_WORDS[operations.data.maintenance.state]}
      </InstanceFact>
    </>
  );
}

const CLEANUP_IN_WORDS = {
  degraded: "Failing or late",
  healthy: "Runs on schedule",
  missing: "Has not run yet",
} as const;

function InstanceFact(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="setting">
      <span className="t-meta">{props.label}</span>
      <span className="text-right">{props.children}</span>
    </div>
  );
}

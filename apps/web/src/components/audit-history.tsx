import { useQuery } from "@tanstack/react-query";
import { useDashboardClient } from "../lib/dashboard-client";
import { auditActionInWords, auditActorInWords } from "../lib/words/audit";
import { ErrorNote, Skeleton } from "./ui";

/**
 * A resource's change history: every request that changed it or tried to. Reads and dry runs
 * change nothing, so they appear nowhere in the audit (ADR 0016).
 */
export function AuditHistory(
  filters:
    | { readonly automation: string; readonly worker?: never }
    | { readonly worker: string; readonly automation?: never },
) {
  const { api, environment, queryScope } = useDashboardClient();
  const audit = useQuery({
    refetchInterval: 15_000,
    queryKey: [
      filters.worker === undefined ? "audit" : "workers",
      ...queryScope,
      "history",
      filters,
    ],
    queryFn: () =>
      api.listAudit({
        ...filters,
        ...(filters.automation !== undefined ? { environment } : {}),
        limit: 50,
      }),
  });
  if (audit.isError)
    return <ErrorNote error={audit.error} title="The audit could not be loaded." />;
  if (audit.data === undefined) return <Skeleton label="Loading history" lines={2} />;
  return (
    <div className="card rows mt-4 overflow-hidden" data-testid="resource-audit">
      <h3 className="setting t-section">Change history</h3>
      {audit.data.events.length === 0 ? (
        <p className="setting t-meta">No changes recorded.</p>
      ) : (
        audit.data.events.map((event) => (
          <div className="setting" key={event.id}>
            <div>
              <p>{auditActionInWords(event)}</p>
              <p className="t-meta">
                {auditActorInWords(event.actor)} ·{" "}
                {new Date(event.occurredAt).toLocaleString("en-GB")}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

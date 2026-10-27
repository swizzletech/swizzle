// What every drawing of an automation's flow starts from: its flow.mermaid parsed to a graph, the
// step sites of a deployment's entrypoint, how many recent runs reached each step, and where the
// flow and the code disagree. The Runs, About and Play tabs share these reads through React Query.

import {
  extractFlowNodeIds,
  type FlowDriftWarning,
  flowDrift,
  type StepSite,
} from "@swizzle/config/browser";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { AutomationSource, StepReach } from "./api";
import { useDashboardClient } from "./dashboard-client";
import { parseFlow } from "./flow-source";
import type { FlowGraph } from "./track";

export interface AutomationFlow {
  /** Null until parsed, and when the automation has no flowchart. */
  readonly graph: FlowGraph | null;
  /** True while the diagram is still loading or parsing. */
  readonly pending: boolean;
  /** The flow.mermaid source, for Mermaid's own drawing of a diagram that is not a flowchart. */
  readonly mermaid: string | null;
  readonly mermaidError: string | null;
  readonly source: AutomationSource | null;
  /** Why the source request itself failed; `source.error` is the API's own report. */
  readonly sourceError: string | null;
  readonly refetchSource: () => void;
  readonly sites: readonly StepSite[];
  readonly stepKeys: ReadonlySet<string>;
  readonly reach: StepReach | null;
  readonly drift: readonly FlowDriftWarning[];
}

/**
 * The flow of one deployment: the active one, or the deployment of the run that shows. Both reads
 * are keyed by the deployment, which never changes once published, so they are read once.
 */
export function useAutomationFlow(automationSlug: string, deploymentId: string): AutomationFlow {
  const { api, queryScope } = useDashboardClient();
  const diagram = useQuery({
    queryFn: () => api.getMermaidDiagram(automationSlug, deploymentId),
    queryKey: ["diagram", automationSlug, deploymentId, ...queryScope],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mermaid = diagram.data?.available === true ? diagram.data.content : null;
  const parsed = useQuery({
    enabled: mermaid !== null,
    queryFn: () => parseFlow(mermaid ?? ""),
    queryKey: ["flow-graph", mermaid],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const source = useQuery({
    queryFn: () => api.getAutomationSource(automationSlug, deploymentId),
    queryKey: ["source", automationSlug, deploymentId, ...queryScope],
    staleTime: Number.POSITIVE_INFINITY,
  });
  const reach = useQuery({
    queryFn: () => api.getStepReach(automationSlug),
    queryKey: ["step-reach", automationSlug, ...queryScope],
    refetchInterval: 15_000,
  });
  const graph = parsed.data ?? null;
  const sites = source.data?.steps ?? [];
  return useMemo(
    () => ({
      drift: graph === null ? [] : flowDrift(extractFlowNodeIds(mermaid ?? ""), sites),
      graph,
      mermaid,
      mermaidError: diagram.error?.message ?? diagram.data?.error ?? null,
      pending: diagram.isPending || (mermaid !== null && parsed.isPending),
      reach: reach.data ?? null,
      sites,
      refetchSource: () => void source.refetch(),
      source: source.data ?? null,
      sourceError: source.error?.message ?? null,
      stepKeys: new Set(sites.map((site) => site.key)),
    }),
    [
      diagram.data,
      diagram.error,
      diagram.isPending,
      graph,
      mermaid,
      parsed.isPending,
      reach.data,
      sites,
      source.data,
      source.error,
      source.refetch,
    ],
  );
}

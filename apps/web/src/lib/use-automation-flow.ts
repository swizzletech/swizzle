import {
  extractFlowNodeIds,
  type FlowDriftWarning,
  flowDrift,
  type StepSite,
  stepFamily,
} from "@swizzle/config/browser";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { AutomationSource, StepReach } from "./api";
import { useDashboardClient } from "./dashboard-client";
import { parseFlow } from "./flow-source";
import type { FlowGraph } from "./track";

export interface AutomationFlow {
  readonly graph: FlowGraph | null;
  readonly pending: boolean;
  readonly mermaid: string | null;
  readonly mermaidError: string | null;
  readonly source: AutomationSource | null;
  readonly sourceError: string | null;
  readonly refetchSource: () => void;
  readonly sites: readonly StepSite[];
  readonly families: ReadonlySet<string>;
  readonly reach: StepReach | null;
  readonly drift: readonly FlowDriftWarning[];
}

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
      families: new Set(sites.map((site) => stepFamily(site.key))),
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

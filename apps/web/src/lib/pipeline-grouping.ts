import type { AutomationSummary } from "./api";

/**
 * A standalone automation that is not part of any multi-stage pipeline. Rendered
 * as a normal row, exactly as before pipeline grouping existed.
 */
interface StandaloneListItem {
  readonly kind: "single";
  readonly automation: AutomationSummary;
}

/**
 * A connected pipeline of chained automations (≥2 members). Rendered as one
 * collapsible group row whose expansion reveals the members in stage order.
 */
interface PipelineListItem {
  readonly kind: "group";
  /** Stable id for client-side expand state; derived from the entry automation. */
  readonly key: string;
  /** The pipeline's entry point: the non-chain (webhook/cron) member, or the topological root. */
  readonly entry: AutomationSummary;
  /** Members grouped into topological layers — stages in one layer run in parallel. */
  readonly layers: readonly (readonly AutomationSummary[])[];
  /** Members in topological order — entry first, join last. */
  readonly members: readonly AutomationSummary[];
  readonly stageCount: number;
  /** Any member's latest run is queued or running. */
  readonly live: boolean;
  /** Any member's latest run failed or dead-lettered. */
  readonly failing: boolean;
  /** Most recent run activity (queuedAt) across all members, or null if none ran. */
  readonly lastActivityAt: string | null;
}

export type AutomationListItem = StandaloneListItem | PipelineListItem;

/** An automation is "live" when its latest run is still queued or running. */
export function isAutomationLive(automation: AutomationSummary): boolean {
  const status = automation.lastRun?.status;
  return status === "queued" || status === "running";
}

function isAutomationFailing(automation: AutomationSummary): boolean {
  const status = automation.lastRun?.status;
  return status === "failed" || status === "dead-lettered";
}

function chainSourceSlugs(automation: AutomationSummary): readonly string[] {
  return automation.trigger?.chainSourceAutomationSlugs ?? [];
}

/** The automations this one starts with `invokeAutomation`, as the API names them. */
export function invokeTargets(automation: AutomationSummary): readonly string[] {
  return automation.invokesAutomationSlugs;
}

/** The slugs that lead into each automation: chain sources and inviters. */
type SourceIndex = ReadonlyMap<string, readonly string[]>;

/**
 * Every automation whose run leads to each one: its chain sources, and the automations that
 * invoke it. Both are edges of the pipeline, so both group and order it. Built once per list, so
 * grouping, layering and entry selection walk the edges and not the list squared.
 */
function indexSources(all: readonly AutomationSummary[]): SourceIndex {
  const sources = new Map<string, string[]>();
  for (const automation of all) {
    sources.set(automation.automationSlug, [...chainSourceSlugs(automation)]);
  }
  for (const automation of all) {
    for (const target of invokeTargets(automation)) {
      sources.get(target)?.push(automation.automationSlug);
    }
  }
  return sources;
}

function isChainTriggered(automation: AutomationSummary): boolean {
  return automation.trigger?.triggerType === "chain";
}

/**
 * Group a flat automation list into pipelines by connected components over the
 * chain-trigger and invoke edges. Each automation is a node; each resolved chain
 * source and each invoke target is an undirected edge to its consumer. Components
 * with ≥2 members become one pipeline group (members topologically sorted, entry
 * first); everything else stays a standalone row. Groups are emitted at the
 * position of their first-encountered member, so the overall list order stays stable.
 */
export function groupAutomationsIntoPipelines(
  automations: readonly AutomationSummary[],
): readonly AutomationListItem[] {
  const bySlug = new Map<string, AutomationSummary>();
  for (const automation of automations) {
    bySlug.set(automation.automationSlug, automation);
  }

  // Union-find over slugs, joining each consumer with every source present in
  // the current list (a source in another environment is simply absent here).
  const parent = new Map<string, string>();
  const find = (slug: string): string => {
    let root = slug;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) break;
      root = next;
    }
    parent.set(slug, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const sources = indexSources(automations);
  for (const automation of automations) {
    parent.set(automation.automationSlug, automation.automationSlug);
  }
  for (const automation of automations) {
    for (const source of sources.get(automation.automationSlug) ?? []) {
      if (bySlug.has(source)) union(automation.automationSlug, source);
    }
  }

  const componentMembers = new Map<string, AutomationSummary[]>();
  for (const automation of automations) {
    const root = find(automation.automationSlug);
    const members = componentMembers.get(root);
    if (members) members.push(automation);
    else componentMembers.set(root, [automation]);
  }

  const items: AutomationListItem[] = [];
  const emitted = new Set<string>();
  for (const automation of automations) {
    const root = find(automation.automationSlug);
    const members = componentMembers.get(root) ?? [automation];
    if (members.length < 2) {
      items.push({ automation, kind: "single" });
      continue;
    }
    if (emitted.has(root)) continue;
    emitted.add(root);
    items.push(buildPipeline(members, sources));
  }

  return items;
}

function buildPipeline(
  members: readonly AutomationSummary[],
  sources: SourceIndex,
): PipelineListItem {
  const memberSlugs = new Set(members.map((member) => member.automationSlug));
  const layers = topologicalLayers(members, memberSlugs, sources);
  const ordered = layers.flat();
  const entry = pickEntry(ordered, memberSlugs, sources);

  let live = false;
  let failing = false;
  let lastActivityAt: string | null = null;
  for (const member of members) {
    if (isAutomationLive(member)) live = true;
    if (isAutomationFailing(member)) failing = true;
    const queuedAt = member.lastRun?.queuedAt ?? null;
    if (queuedAt && (lastActivityAt === null || queuedAt > lastActivityAt)) {
      lastActivityAt = queuedAt;
    }
  }

  return {
    entry,
    failing,
    key: entry.automationSlug,
    kind: "group",
    lastActivityAt,
    layers,
    live,
    members: ordered,
    stageCount: ordered.length,
  };
}

/**
 * Kahn topological layering over source→consumer edges: each layer holds the
 * stages whose sources are all satisfied by previous layers, so members of one
 * layer run in parallel. Alphabetical tie-break within a layer keeps the result
 * deterministic across refetches; flattening the layers yields the display order
 * (entry first, join last).
 */
function topologicalLayers(
  members: readonly AutomationSummary[],
  memberSlugs: ReadonlySet<string>,
  sources: SourceIndex,
): readonly (readonly AutomationSummary[])[] {
  const byName = [...members].sort((a, b) => a.automationName.localeCompare(b.automationName));
  const indegree = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const member of byName) {
    indegree.set(member.automationSlug, 0);
    consumers.set(member.automationSlug, []);
  }
  for (const member of byName) {
    for (const source of sources.get(member.automationSlug) ?? []) {
      if (!memberSlugs.has(source)) continue;
      indegree.set(member.automationSlug, (indegree.get(member.automationSlug) ?? 0) + 1);
      consumers.get(source)?.push(member.automationSlug);
    }
  }

  const bySlug = new Map(byName.map((member) => [member.automationSlug, member]));
  let frontier = byName.filter((member) => (indegree.get(member.automationSlug) ?? 0) === 0);
  const layers: (readonly AutomationSummary[])[] = [];
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const layer = [...frontier].sort((a, b) => a.automationName.localeCompare(b.automationName));
    layers.push(layer);
    const next: AutomationSummary[] = [];
    for (const member of layer) {
      seen.add(member.automationSlug);
      for (const consumerSlug of consumers.get(member.automationSlug) ?? []) {
        const remaining = (indegree.get(consumerSlug) ?? 0) - 1;
        indegree.set(consumerSlug, remaining);
        if (remaining === 0) {
          const consumer = bySlug.get(consumerSlug);
          if (consumer && !seen.has(consumerSlug)) next.push(consumer);
        }
      }
    }
    frontier = next;
  }

  // A cycle would leave members unseen; append them as a final layer so nothing is dropped.
  const unseen = byName.filter((member) => !seen.has(member.automationSlug));
  if (unseen.length > 0) layers.push(unseen);
  return layers;
}

/**
 * The pipeline's entry point: prefer a non-chain member (webhook/cron) that has
 * no in-component source, then any topological root, then the first by name.
 */
function pickEntry(
  ordered: readonly AutomationSummary[],
  memberSlugs: ReadonlySet<string>,
  sources: SourceIndex,
): AutomationSummary {
  const fallback = ordered[0];
  if (fallback === undefined) {
    throw new Error("A pipeline component must have at least one member.");
  }
  const roots = ordered.filter((member) =>
    (sources.get(member.automationSlug) ?? []).every((source) => !memberSlugs.has(source)),
  );
  const nonChainRoot = roots.find((member) => !isChainTriggered(member));
  return nonChainRoot ?? roots[0] ?? fallback;
}

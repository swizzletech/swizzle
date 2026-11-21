export const AUTOMATION_TABS = ["runs", "about", "play", "versions"] as const;
export type AutomationTab = (typeof AUTOMATION_TABS)[number];

export interface AutomationSearch {
  readonly run?: string | undefined;
  readonly tab?: AutomationTab | undefined;
}

export const RUN_FILTERS = ["all", "needs-you", "running", "failed", "succeeded"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

export interface RunsSearch {
  readonly automation?: string | undefined;
  readonly selected?: string | undefined;
  readonly status?: Exclude<RunFilter, "all"> | undefined;
}

export interface CredentialsSearch {
  readonly connect?: string | undefined;
  readonly name?: string | undefined;
  readonly project?: string | undefined;
  readonly scopes?: string | undefined;
  readonly secret?: string | undefined;
}

export const PROJECT_TABS = ["access", "environments", "service-accounts", "credentials"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export interface ProjectSearch {
  readonly tab?: ProjectTab | undefined;
}

export const SETTINGS_SECTIONS = [
  "agent-access",
  "notifications",
  "account",
  "two-factor",
  "people",
  "teams",
  "workers",
  "status",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string): value is SettingsSection {
  return oneOf(SETTINGS_SECTIONS, value) !== undefined;
}

type RawSearch = Record<string, unknown>;

export function parseAutomationSearch(search: RawSearch): AutomationSearch {
  return {
    run: text(search.run),
    tab: oneOf(AUTOMATION_TABS, search.tab),
  };
}

export function parseRunsSearch(search: RawSearch): RunsSearch {
  return {
    automation: text(search.automation),
    selected: text(search.selected),
    status: oneOf(
      RUN_FILTERS.filter((filter) => filter !== "all"),
      search.status,
    ),
  };
}

export function parseCredentialsSearch(search: RawSearch): CredentialsSearch {
  return {
    connect: text(search.connect),
    name: text(search.name),
    project: text(search.project),
    scopes: text(search.scopes),
    secret: text(search.secret),
  };
}

export function parseProjectSearch(search: RawSearch): ProjectSearch {
  return { tab: oneOf(PROJECT_TABS, search.tab) };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value);
}

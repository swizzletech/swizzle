// The search parameters each page reads from its URL, and the parsers the router validates them
// with. They live apart from the pages, so the router's entry chunk does not pull a page in.
// Agents print these links too, for example /credentials?connect=google&name=google-jan.

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
  /** Opens the connect form for this provider. */
  readonly connect?: string | undefined;
  /** The connection name the connect form starts with; opens the form too. */
  readonly name?: string | undefined;
  /**
   * The project in view, by slug or id: the lists show only its credentials, and a new secret or
   * connection joins it unless the form picks another.
   */
  readonly project?: string | undefined;
  /** Comma-separated scopes the connect form starts with. */
  readonly scopes?: string | undefined;
  /** The secret name the add form starts with. */
  readonly secret?: string | undefined;
}

/**
 * A project's page: who may do what, its environments and their protection, its service accounts,
 * and the credentials it shares and is offered.
 */
export const PROJECT_TABS = ["access", "environments", "service-accounts", "credentials"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export interface ProjectSearch {
  readonly tab?: ProjectTab | undefined;
}

/**
 * Settings' sections in the order the nav lists them, one page each at /settings/<section>. The
 * first four belong to every person; the rest run the instance, for its owners and admins.
 */
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

// The router merges a route's parsed search over the raw URL search, so each parser returns every
// key: an undefined value replaces a stale or mistyped one such as ?tab=readme. The URL omits it.

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

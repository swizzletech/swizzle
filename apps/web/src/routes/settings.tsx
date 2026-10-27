// Settings `/settings`: Agent access, Notifications, Account, Two-factor sign-in, People, Teams and
// Workers (for owners and admins) and Instance, each a section with an anchor (#agent-access,
// #notifications, #account, #two-factor, #people, #teams, #workers, #instance) other pages link
// to. A member sees no part only an instance owner or admin may read. Each section is a module in
// routes/settings/ that draws its own frame with its anchor; SECTIONS lists them once for the nav
// beside them, which marks the one on screen, and for the page.

import { type Query, useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

import type { AuthStatusResponse } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useAuthStatus } from "../lib/queries";
import { Account } from "./settings/account";
import { AgentAccess } from "./settings/agent-access";
import { Instance } from "./settings/instance";
import { Notifications } from "./settings/notifications";
import { People } from "./settings/people";
import { SECTION_DATA, Section } from "./settings/section";
import { Teams } from "./settings/teams";
import { TwoFactor } from "./settings/two-factor";
import { Workers } from "./settings/workers";
import "./settings.css";

interface Viewer {
  readonly me: NonNullable<AuthStatusResponse["user"]>;
  readonly operator: boolean;
  readonly mailConfigured: boolean;
  readonly queryScope: readonly unknown[];
}

const SECTIONS: readonly {
  readonly id: string;
  readonly label: string;
  /** Only an instance owner or admin sees it. */
  readonly operatorOnly: boolean;
  readonly render: (viewer: Viewer) => ReactNode;
}[] = [
  { id: "agent-access", label: "Agent access", operatorOnly: false, render: () => <AgentAccess /> },
  {
    id: "notifications",
    label: "Notifications",
    operatorOnly: false,
    render: ({ operator }) => <Notifications operator={operator} />,
  },
  { id: "account", label: "Account", operatorOnly: false, render: () => <Account /> },
  {
    id: "two-factor",
    label: "Two-factor sign-in",
    operatorOnly: false,
    render: () => <TwoFactor />,
  },
  {
    id: "people",
    label: "People",
    operatorOnly: true,
    render: ({ mailConfigured, me }) => (
      <Section
        id="people"
        intro="Invite people and decide what they may do. Suspending someone signs them out at once and stops their agent tokens."
        title="People"
      >
        <People mailConfigured={mailConfigured} me={me} />
      </Section>
    ),
  },
  {
    id: "teams",
    label: "Teams",
    operatorOnly: true,
    render: () => (
      <Section
        id="teams"
        intro="A team gives every member the roles a project's admins give the team, on the project's Access tab. Every new project grants production to the team Release, so add the people who may release to it."
        title="Teams"
      >
        <Teams />
      </Section>
    ),
  },
  {
    id: "workers",
    label: "Workers",
    operatorOnly: true,
    // A new environment starts the enrollment form empty.
    render: ({ queryScope }) => <Workers key={JSON.stringify(queryScope)} />,
  },
  {
    id: "instance",
    label: "Instance",
    operatorOnly: false,
    render: ({ operator }) => <Instance operator={operator} />,
  },
];

// The keys that scroll the page, unless the focused control takes them: a field takes them all, a
// button or summary takes Space to press or open itself.
const SCROLL_KEYS = new Set([" ", "ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp"]);
const FIELD = "input, select, textarea, [contenteditable]";
const TAKES_SPACE = `${FIELD}, button, summary`;

// The sections' own queries, and the shared project list People, Workers and Agent access list.
const isSectionData = (query: Query) =>
  query.meta?.sectionData === SECTION_DATA.sectionData || query.queryKey[0] === "projects";

export function SettingsPage() {
  const { queryScope } = useDashboardClient();
  const status = useAuthStatus();
  const me = status.data?.user ?? null;
  const operator = me !== null && (me.role === "owner" || me.role === "admin");
  const sections = SECTIONS.filter((section) => operator || !section.operatorOnly);
  const { jumpTo, onScreen } = useSectionOnScreen(
    me === null ? [] : sections.map((section) => section.id),
  );
  return (
    <div className="settings">
      <nav aria-label="Settings" className="snav">
        {sections.map(({ id, label }) => (
          <a
            aria-current={onScreen === id ? "location" : undefined}
            href={`#${id}`}
            key={id}
            // A link to the section the address already names fires no hashchange.
            onClick={(event) => {
              if (window.location.hash !== `#${id}`) return;
              event.preventDefault();
              jumpTo(id);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="min-w-0">
        <h1 className="t-page">Settings</h1>
        {me === null
          ? null
          : sections.map((section) => (
              <Fragment key={section.id}>
                {section.render({
                  mailConfigured: status.data?.mailConfigured === true,
                  me,
                  operator,
                  queryScope,
                })}
              </Fragment>
            ))}
      </div>
    </div>
  );
}

/**
 * The section the reader is at, and the jump to a section by name. The mark is the last section
 * whose top passed the upper third of the screen, or, once the page cannot scroll further, the
 * last one. A section the address names wins until the reader scrolls, because a short section near
 * the end can never reach the upper third.
 *
 * The sections fetch their own data (queries marked `SECTION_DATA`) and grow when it arrives, so
 * the page jumps to the named one once none of that is loading, whatever else the app fetches, and
 * only then: no section above it changes height after the jump. Only the reader's wheel, touch,
 * scroll keys or scrollbar end the named section's win, and one before the jump also cancels the
 * jump. The page moves without the reader too, as when a window resized at the end of the page
 * lowers the bottom. The scroll position cannot tell that from the reader's scroll, so the hook
 * reads their input instead.
 */
function useSectionOnScreen(ids: readonly string[]): {
  readonly onScreen: string | undefined;
  readonly jumpTo: (id: string) => void;
} {
  const queryClient = useQueryClient();
  // Renders in the same batch as the data a section's query brings.
  const fetching = useIsFetching({ predicate: isSectionData });
  const [onScreen, setOnScreen] = useState<string>();
  const page = useRef<{ jumpTo(id: string): void; loaded(): void } | undefined>(undefined);
  const key = ids.join(" ");
  useEffect(() => {
    const sections = key
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((section) => section !== null);
    if (sections.length === 0) return;
    let named: HTMLElement | undefined;
    let loaded = false;
    const mark = () => {
      const line = window.innerHeight / 3;
      const atBottom =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;
      let current = sections[0];
      for (const section of sections) {
        if (atBottom || section.getBoundingClientRect().top <= line) current = section;
      }
      setOnScreen((named ?? current)?.id);
    };
    const jump = () => {
      named?.scrollIntoView();
      mark();
    };
    const name = (hash: string) => {
      named = sections.find((section) => `#${section.id}` === hash);
      if (loaded) jump();
      else mark();
    };
    const navigated = () => name(window.location.hash);
    const readerScrolls = () => {
      named = undefined;
    };
    const readerKeys = (event: KeyboardEvent) => {
      const { key, target } = event;
      const control = key === " " ? TAKES_SPACE : FIELD;
      if (SCROLL_KEYS.has(key) && !(target instanceof Element && target.closest(control)))
        readerScrolls();
    };
    // A press on the page's own scrollbar lands on the root element.
    const readerDrags = (event: PointerEvent) => {
      if (event.target === document.documentElement) readerScrolls();
    };
    page.current = {
      jumpTo: (id) => name(`#${id}`),
      loaded: () => {
        if (loaded) return;
        loaded = true;
        jump();
      },
    };
    navigated();
    const listening = new AbortController();
    const { signal } = listening;
    window.addEventListener("scroll", mark, { passive: true, signal });
    window.addEventListener("hashchange", navigated, { signal });
    window.addEventListener("wheel", readerScrolls, { passive: true, signal });
    window.addEventListener("touchmove", readerScrolls, { passive: true, signal });
    window.addEventListener("keydown", readerKeys, { signal });
    window.addEventListener("pointerdown", readerDrags, { signal });
    return () => {
      page.current = undefined;
      listening.abort();
    };
  }, [key]);
  useEffect(() => {
    // On the first render no section has started its fetch yet; this effect runs after theirs.
    if (fetching === 0 && queryClient.isFetching({ predicate: isSectionData }) === 0)
      page.current?.loaded();
  }, [fetching, queryClient]);
  return { jumpTo: (id) => page.current?.jumpTo(id), onScreen };
}

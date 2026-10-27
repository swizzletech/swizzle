// Settings `/settings`: Agent access, Notifications, Account, Two-factor sign-in, People, Teams and
// Workers (for owners and admins) and Instance, each a section with an anchor (#agent-access,
// #notifications, #account, #two-factor, #people, #teams, #workers, #instance) other pages link
// to. A member sees no part only an instance owner or admin may read. Each section is a module in
// routes/settings/ that draws its own frame with its anchor; SECTIONS lists them once for the nav
// beside them, which marks the one on screen, and for the page.

import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";

import type { AuthStatusResponse } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useAuthStatus } from "../lib/queries";
import { Account } from "./settings/account";
import { AgentAccess } from "./settings/agent-access";
import { Instance } from "./settings/instance";
import { Notifications } from "./settings/notifications";
import { People } from "./settings/people";
import { Section } from "./settings/section";
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
 * The sections fetch their own data and grow when it arrives, so the page jumps to the named one
 * once nothing is loading, and only then: no section above it changes height after the jump, and
 * any later scroll away from where it left the page is the reader's. Before the jump the page has
 * not moved, so a scroll is the reader's too; one that leaves the named section off screen goes
 * elsewhere and cancels the jump.
 */
function useSectionOnScreen(ids: readonly string[]): {
  readonly onScreen: string | undefined;
  readonly jumpTo: (id: string) => void;
} {
  const queryClient = useQueryClient();
  // Renders in the same batch as the data a section's query brings.
  const fetching = useIsFetching();
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
    // Where the last jump left the page; undefined until the sections have loaded.
    let jumpedTo: number | undefined;
    const opened = window.scrollY;
    const mark = () => {
      if (jumpedTo !== undefined && Math.abs(window.scrollY - jumpedTo) >= 1) named = undefined;
      if (jumpedTo === undefined && named !== undefined && Math.abs(window.scrollY - opened) >= 1) {
        const { bottom, top } = named.getBoundingClientRect();
        if (bottom <= 0 || top >= window.innerHeight) named = undefined;
      }
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
      jumpedTo = window.scrollY;
      mark();
    };
    const name = (hash: string) => {
      named = sections.find((section) => `#${section.id}` === hash);
      if (jumpedTo === undefined) mark();
      else jump();
    };
    const navigated = () => name(window.location.hash);
    page.current = {
      jumpTo: (id) => name(`#${id}`),
      loaded: () => {
        if (jumpedTo === undefined) jump();
      },
    };
    navigated();
    window.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("hashchange", navigated);
    return () => {
      page.current = undefined;
      window.removeEventListener("scroll", mark);
      window.removeEventListener("hashchange", navigated);
    };
  }, [key]);
  useEffect(() => {
    // On the first render no section has started its fetch yet; this effect runs after theirs.
    if (fetching === 0 && queryClient.isFetching() === 0) page.current?.loaded();
  }, [fetching, queryClient]);
  return { jumpTo: (id) => page.current?.jumpTo(id), onScreen };
}

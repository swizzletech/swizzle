// Settings `/settings/<section>`: one page per section, with a nav in two groups. "You" holds what
// every person sets for themselves: Agent access, Notifications, Account and Two-factor sign-in.
// "Instance" holds what runs the instance, for its owners and admins: People, Teams, Workers and
// Status. A member sees neither the group nor its sections, and an address of one opens the first
// section instead. The foot of the nav names the version for everyone. Each section's title and
// intro are its page's head; its content is a module in routes/settings/.

import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Page } from "../components/page";
import { NotFound } from "../components/shell";
import type { AuthStatusResponse } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useAuthStatus } from "../lib/queries";
import { isSettingsSection, SETTINGS_SECTIONS, type SettingsSection } from "../lib/search";
import { versionInWords } from "../lib/words/runs";
import { Account } from "./settings/account";
import { AgentAccess } from "./settings/agent-access";
import { Notifications } from "./settings/notifications";
import { People } from "./settings/people";
import { Status } from "./settings/status";
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

/** "you" is every person's own; "instance" is only for the instance's owners and admins. */
type Group = "you" | "instance";

const GROUP_LABEL: Record<Group, string> = { instance: "Instance", you: "You" };

const SECTIONS: Record<
  SettingsSection,
  {
    readonly label: string;
    readonly intro: string;
    readonly group: Group;
    readonly render: (viewer: Viewer) => ReactNode;
  }
> = {
  "agent-access": {
    group: "you",
    intro:
      "Connect a coding agent, a script or CI to this instance through the swizzle CLI. Choose who it acts as.",
    label: "Agent access",
    render: () => <AgentAccess />,
  },
  notifications: {
    group: "you",
    intro: "Swizzle messages you on Telegram when runs fail, so you need not watch this page.",
    label: "Notifications",
    render: ({ operator }) => <Notifications operator={operator} />,
  },
  account: {
    group: "you",
    intro:
      "Changing the password signs out every other browser. Agent tokens keep working until you revoke them.",
    label: "Account",
    render: () => <Account />,
  },
  "two-factor": {
    group: "you",
    intro:
      "Sign-in asks for a code from an authenticator app, such as Google Authenticator, 1Password or Aegis, after the password. Turning it on or off signs out every other browser. Agent tokens keep working.",
    label: "Two-factor sign-in",
    render: () => <TwoFactor />,
  },
  people: {
    group: "instance",
    intro:
      "Invite people and decide what they may do. Suspending someone signs them out at once and stops their agent tokens.",
    label: "People",
    render: ({ mailConfigured, me }) => <People mailConfigured={mailConfigured} me={me} />,
  },
  teams: {
    group: "instance",
    intro:
      "A team gives every member the roles a project's admins give the team, on the project's Access tab. Every new project grants production to the Release team, so add the people who may release to it.",
    label: "Teams",
    render: () => <Teams />,
  },
  workers: {
    group: "instance",
    intro: "Every machine that runs automations, its groups and what it runs now.",
    label: "Workers",
    // A new environment starts the enrollment form empty.
    render: ({ queryScope }) => <Workers key={JSON.stringify(queryScope)} />,
  },
  status: {
    group: "instance",
    intro: "Whether the platform runs. Problems also show on the Overview.",
    label: "Status",
    render: () => <Status />,
  },
};

export function SettingsPage() {
  const { section } = useParams({ from: "/settings/$section" });
  const { queryScope } = useDashboardClient();
  const status = useAuthStatus();
  const me = status.data?.user ?? null;
  if (!isSettingsSection(section)) return <NotFound />;
  // The shell renders pages only once someone is signed in.
  if (me === null) return null;
  const operator = me.role === "owner" || me.role === "admin";
  const groups: readonly Group[] = operator ? ["you", "instance"] : ["you"];
  const shown = SECTIONS[section];
  if (!groups.includes(shown.group)) {
    return <Navigate params={{ section: SETTINGS_SECTIONS[0] }} replace to="/settings/$section" />;
  }
  return (
    <Page
      description={shown.intro}
      path={{ current: shown.label, parent: { label: "Settings", to: "/settings" } }}
      title={shown.label}
      type="administration"
    >
      <div className="settings">
        <nav aria-label="Settings" className="snav">
          {groups.map((group) => (
            <div className="snav-group" key={group}>
              <p className="snav-label">{GROUP_LABEL[group]}</p>
              {SETTINGS_SECTIONS.filter((id) => SECTIONS[id].group === group).map((id) => (
                <Link
                  aria-current={id === section ? "page" : undefined}
                  key={id}
                  params={{ section: id }}
                  to="/settings/$section"
                >
                  {SECTIONS[id].label}
                </Link>
              ))}
            </div>
          ))}
          <Version />
        </nav>
        <div className="stack min-w-0">
          {shown.render({
            mailConfigured: status.data?.mailConfigured === true,
            me,
            operator,
            queryScope,
          })}
        </div>
      </div>
    </Page>
  );
}

/** The version, so anyone can name it when they report a problem or match their CLI to it. */
function Version() {
  const { api } = useDashboardClient();
  const health = useQuery({ queryFn: () => api.getHealth(), queryKey: ["health"] });
  if (health.data === undefined) return null;
  return <p className="snav-version">Swizzle {versionInWords(health.data.version)}</p>;
}

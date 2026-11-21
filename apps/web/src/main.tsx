import "./styles.css";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  redirect,
  useMatches,
} from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";

import { ConfirmProvider } from "./components/confirm";
import { AppShell, NotFound } from "./components/shell";
import { DashboardSessionProvider } from "./lib/dashboard-client";
import { createAppQueryClient } from "./lib/query-client";
import {
  parseAutomationSearch,
  parseCredentialsSearch,
  parseProjectSearch,
  parseRunsSearch,
  SETTINGS_SECTIONS,
} from "./lib/search";

const OverviewPage = lazyRouteComponent(() => import("./routes/overview"), "OverviewPage");
const AutomationPage = lazyRouteComponent(() => import("./routes/automation"), "AutomationPage");
const RunsPage = lazyRouteComponent(() => import("./routes/runs"), "RunsPage");
const ProjectsPage = lazyRouteComponent(() => import("./routes/projects"), "ProjectsPage");
const ProjectPage = lazyRouteComponent(() => import("./routes/project"), "ProjectPage");
const CredentialsPage = lazyRouteComponent(() => import("./routes/credentials"), "CredentialsPage");
const SettingsPage = lazyRouteComponent(() => import("./routes/settings"), "SettingsPage");
const InvitationPage = lazyRouteComponent(() => import("./routes/account"), "InvitationPage");
const ResetPasswordPage = lazyRouteComponent(() => import("./routes/account"), "ResetPasswordPage");

function Root() {
  const outsideShell = useMatches({
    select: (matches) => matches.some((match) => match.staticData.outsideShell === true),
  });
  if (outsideShell) return <Outlet />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const rootRoute = createRootRoute({
  component: Root,
  notFoundComponent: NotFound,
});

const invitationRoute = createRoute({
  component: InvitationPage,
  getParentRoute: () => rootRoute,
  path: "/invitation",
  staticData: { outsideShell: true },
});

const resetPasswordRoute = createRoute({
  component: ResetPasswordPage,
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  staticData: { outsideShell: true },
});

const overviewRoute = createRoute({
  component: OverviewPage,
  getParentRoute: () => rootRoute,
  path: "/",
});

const automationRoute = createRoute({
  component: AutomationPage,
  getParentRoute: () => rootRoute,
  path: "/automations/$automationSlug",
  validateSearch: parseAutomationSearch,
});

const runsRoute = createRoute({
  component: RunsPage,
  getParentRoute: () => rootRoute,
  path: "/runs",
  validateSearch: parseRunsSearch,
});

const projectsRoute = createRoute({
  component: ProjectsPage,
  getParentRoute: () => rootRoute,
  path: "/projects",
});

const projectRoute = createRoute({
  component: ProjectPage,
  getParentRoute: () => rootRoute,
  path: "/projects/$project",
  validateSearch: parseProjectSearch,
});

const credentialsRoute = createRoute({
  component: CredentialsPage,
  getParentRoute: () => rootRoute,
  path: "/credentials",
  validateSearch: parseCredentialsSearch,
});

const settingsRoute = createRoute({
  beforeLoad: () => {
    throw redirect({
      params: { section: SETTINGS_SECTIONS[0] },
      replace: true,
      to: "/settings/$section",
    });
  },
  getParentRoute: () => rootRoute,
  path: "/settings",
});

const settingsSectionRoute = createRoute({
  component: SettingsPage,
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  automationRoute,
  runsRoute,
  projectsRoute,
  projectRoute,
  credentialsRoute,
  settingsRoute,
  settingsSectionRoute,
  invitationRoute,
  resetPasswordRoute,
]);
const router = createRouter({ routeTree });
const queryClient = createAppQueryClient();
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found.");
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    outsideShell?: boolean;
  }
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DashboardSessionProvider>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </DashboardSessionProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

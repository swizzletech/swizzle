// First, so Tailwind declares its layer order before a component's stylesheet adds to the
// components layer; a component layer declared first would sink below base.
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

// The dashboard has five places: Overview, Runs, Projects, Credentials and Settings, plus one page
// per automation, per project and per settings section, all inside AppShell, which signs the
// person in. The pages a mailed link opens, /invitation and /reset-password, sit outside it. Each
// page loads on first visit, so a library one page imports (Mermaid and marked on the automation
// page) stays out of the others. Any other address shows NotFound.
// Each route's component is the lazy page itself, never a component that renders it: the router
// loads a route's own component before it renders the route. A page that starts loading only when
// it renders blanks the screen while it loads, and React's dev build logs conditional-use-of-use.
// A page reads its search params and path params with useSearch and useParams.
const OverviewPage = lazyRouteComponent(() => import("./routes/overview"), "OverviewPage");
const AutomationPage = lazyRouteComponent(() => import("./routes/automation"), "AutomationPage");
const RunsPage = lazyRouteComponent(() => import("./routes/runs"), "RunsPage");
const ProjectsPage = lazyRouteComponent(() => import("./routes/projects"), "ProjectsPage");
const ProjectPage = lazyRouteComponent(() => import("./routes/project"), "ProjectPage");
const CredentialsPage = lazyRouteComponent(() => import("./routes/credentials"), "CredentialsPage");
const SettingsPage = lazyRouteComponent(() => import("./routes/settings"), "SettingsPage");
const InvitationPage = lazyRouteComponent(() => import("./routes/account"), "InvitationPage");
const ResetPasswordPage = lazyRouteComponent(() => import("./routes/account"), "ResetPasswordPage");

// A mailed link opens its page before anyone signs in, so a route with `outsideShell` renders
// without the shell. The router's match decides, so every address that reaches the route counts.
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

// The sidebar's Settings opens the first section.
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

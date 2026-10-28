// The frame around every page: sign-in, then the sidebar with the five places, the environment
// switch and the signed-in person with Sign out, and the bar above each page with its trail. At
// phone width the sidebar folds into a sticky header that still shows every place. AppShell signs
// the person in, offers two-factor sign-in after setup, and learns the instance's environments
// before it mounts DashboardClientProvider, so every page reads a known environment.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

import { ApiError } from "../lib/api";
import { sessionApi } from "../lib/api/account";
import {
  DashboardClientProvider,
  useDashboardClient,
  useDashboardSession,
} from "../lib/dashboard-client";
import { useAuthStatus, useMe, useOverview, useProjects } from "../lib/queries";
import { passwordAccepted } from "../lib/words/access";
import {
  AuthScreen,
  NewPasswordField,
  problemInWords,
  startTwoFactor,
  TwoFactorChoice,
  TwoFactorOnboarding,
  type TwoFactorStart,
} from "./auth-screen";
import { Logo } from "./logo";
import { Skeleton } from "./ui";
import "./shell.css";

export function AppShell({ children }: { readonly children: ReactNode }) {
  const { authRevision, refreshAuth } = useDashboardSession();
  const authQuery = useAuthStatus();
  const signedIn = authQuery.data?.authenticated === true;
  const environmentsQuery = useQuery({
    enabled: signedIn,
    queryFn: () => sessionApi.getInstanceEnvironments(),
    queryKey: ["instance-environments", authRevision],
    staleTime: Number.POSITIVE_INFINITY,
  });

  // Held here, not in SignIn: the account is signed in as soon as it exists, and the next status
  // refetch would otherwise replace the two-factor step with the dashboard.
  const [onboarding, setOnboarding] = useState<TwoFactorStart | null>(null);
  const enter = () => {
    setOnboarding(null);
    refreshAuth();
    void authQuery.refetch();
  };

  if (onboarding !== null) return <TwoFactorOnboarding onDone={enter} start={onboarding} />;

  if (authQuery.isLoading) return <Connecting />;

  if (!signedIn) {
    return (
      <SignIn
        error={authQuery.error}
        mailConfigured={authQuery.data?.mailConfigured === true}
        onAccountCreated={setOnboarding}
        onSignedIn={enter}
        setupRequired={authQuery.data?.setupRequired === true}
        setupTokenRequired={authQuery.data?.setupTokenRequired === true}
      />
    );
  }

  if (environmentsQuery.isError) {
    return (
      <div className="grid min-h-screen place-items-center p-8 text-center">
        <div className="grid max-w-md gap-3">
          <p>Swizzle could not tell which environments this instance serves.</p>
          <p className="t-meta">{environmentsQuery.error.message}</p>
          <button
            className="btn quiet mx-auto"
            onClick={() => void environmentsQuery.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (environmentsQuery.data === undefined) return <Connecting />;

  return (
    <DashboardClientProvider instanceEnvironments={environmentsQuery.data}>
      <Frame>{children}</Frame>
    </DashboardClientProvider>
  );
}

const TrailSlot = createContext<HTMLElement | null>(null);

function Frame({ children }: { readonly children: ReactNode }) {
  const { pathname } = useLocation();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const place = DESTINATIONS.find((destination) => isCurrent(pathname, destination.to));
  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <header className="topbar">
          <nav aria-label="Trail" className="crumbs">
            <span className="trail" ref={setSlot} />
            <b className="place">{place?.label}</b>
          </nav>
        </header>
        <TrailSlot.Provider value={slot}>
          <main className="page">{children}</main>
        </TrailSlot.Provider>
      </div>
    </div>
  );
}

/**
 * Where a page sits below its place, drawn in the bar above the page: the place as a link, then
 * the page's own name. A page without a Trail shows its place's name there.
 */
export function Trail(props: {
  readonly parent: { readonly label: string; readonly to: "/" | "/projects" };
  readonly current?: string;
}) {
  const slot = useContext(TrailSlot);
  if (slot === null) return null;
  return createPortal(
    <>
      <Link to={props.parent.to}>{props.parent.label}</Link>
      {props.current === undefined ? null : (
        <>
          <span aria-hidden="true" className="sep">
            /
          </span>
          <b>{props.current}</b>
        </>
      )}
    </>,
    slot,
  );
}

// The logo is drawn inline, not loaded, so the first contentful paint happens before sign-in status
// is known.
function Connecting() {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="grid w-64 gap-3">
        <Logo className="brand justify-self-center" />
        <Skeleton label="Connecting to Swizzle" lines={2} />
      </div>
    </div>
  );
}

type Destination = "/" | "/runs" | "/projects" | "/credentials" | "/settings";

// Each place's icon, drawn on a 24 px grid in 2 px round strokes and shown at 16 px.
const DESTINATIONS: readonly {
  readonly label: string;
  readonly to: Destination;
  readonly icon: ReactNode;
}[] = [
  {
    icon: (
      <>
        <rect height="9" rx="1.5" width="7" x="3" y="3" />
        <rect height="5" rx="1.5" width="7" x="14" y="3" />
        <rect height="9" rx="1.5" width="7" x="14" y="12" />
        <rect height="5" rx="1.5" width="7" x="3" y="16" />
      </>
    ),
    label: "Overview",
    to: "/",
  },
  {
    icon: <path d="M4 6h12M4 12h7M4 18h7M15 13.5v6l5-3z" />,
    label: "Runs",
    to: "/runs",
  },
  {
    icon: (
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
    ),
    label: "Projects",
    to: "/projects",
  },
  {
    icon: (
      <>
        <circle cx="8" cy="16" r="4" />
        <path d="M10.8 13.2 20 4M16 8l3 3M18.5 5.5l2 2" />
      </>
    ),
    label: "Credentials",
    to: "/credentials",
  },
  {
    icon: (
      <>
        <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
        <circle cx="15" cy="6" r="2" />
        <circle cx="9" cy="12" r="2" />
        <circle cx="17" cy="18" r="2" />
      </>
    ),
    label: "Settings",
    to: "/settings",
  },
];

function isCurrent(pathname: string, to: Destination): boolean {
  if (to === "/") return pathname === "/" || pathname.startsWith("/automations/");
  return pathname === to || pathname.startsWith(`${to}/`);
}

function Sidebar() {
  const { pathname } = useLocation();
  const queryClient = useQueryClient();
  const { api, environment, environments, refreshAuth, setEnvironment } = useDashboardClient();
  const me = useMe();
  const needsYou = useOverview().data?.needsYou.length ?? 0;
  const protectedIn = (useProjects().data ?? []).filter((project) =>
    project.protectedEnvironments.includes(environment),
  );
  const signOut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      refreshAuth();
    },
  });
  // A failed sign-out leaves the session active, which matters on a shared device.
  let signOutLabel = "Sign out";
  if (signOut.isError) signOutLabel = "Try again";
  if (signOut.isPending) signOutLabel = "Signing out…";

  return (
    <aside className="side">
      <Link aria-label="Swizzle overview" className="brand side-brand" to="/">
        <Logo />
      </Link>
      <div className="side-env">
        <label className="env">
          <span aria-hidden="true" className="led" />
          <select
            aria-label="Environment"
            onChange={(event) => setEnvironment(event.target.value)}
            value={environment}
          >
            {environments.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {protectedIn.length === 0 ? null : (
          <span
            className="chip warn"
            data-testid="environment-protected"
            title={`Protected in ${protectedIn.map((project) => project.name).join(", ")}: a change needs an environment grant.`}
          >
            Protected
          </span>
        )}
      </div>
      <nav aria-label="Dashboard" className="side-nav">
        {DESTINATIONS.map((destination) => (
          <Link
            aria-current={isCurrent(pathname, destination.to) ? "page" : undefined}
            className="navlink"
            key={destination.to}
            to={destination.to}
          >
            <svg
              aria-hidden="true"
              className="icon"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              {destination.icon}
            </svg>
            {destination.label}
            {destination.to === "/" && needsYou > 0 ? (
              <span className="count" title={`${needsYou} need you`}>
                {needsYou}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        {me === null ? null : (
          <>
            <span aria-hidden="true" className="avatar">
              {initials(me.name)}
            </span>
            <span className="who">
              <b>{me.name}</b>
              <span>{me.role}</span>
            </span>
          </>
        )}
        {signOut.isError ? (
          <span className="signout-error" role="alert">
            Not signed out
          </span>
        ) : null}
        <button
          className="signout"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
          title={signOut.isError ? signOut.error.message : undefined}
          type="button"
        >
          {signOutLabel}
        </button>
      </div>
    </aside>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

function SignIn(props: {
  readonly error: unknown;
  readonly mailConfigured: boolean;
  readonly onAccountCreated: (start: TwoFactorStart) => void;
  readonly onSignedIn: () => void;
  readonly setupRequired: boolean;
  readonly setupTokenRequired: boolean;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [offerTwoFactor, setOfferTwoFactor] = useState(true);
  // The second step, once the password was right and two-factor sign-in is on.
  const [codeAsked, setCodeAsked] = useState(false);
  const [code, setCode] = useState("");
  const [forgot, setForgot] = useState(false);
  const submit = useMutation({
    mutationFn: async (): Promise<"signed-in" | "code" | TwoFactorStart> => {
      if (props.setupRequired) {
        await sessionApi.setUp({
          email,
          name,
          password,
          ...(props.setupTokenRequired ? { setupToken } : {}),
        });
        return offerTwoFactor ? await startTwoFactor(password) : "signed-in";
      }
      if (codeAsked) {
        await sessionApi.verifySignInCode(code);
        return "signed-in";
      }
      const result = await sessionApi.signIn({ email, password });
      return "twoFactorRedirect" in result ? "code" : "signed-in";
    },
    onError: (error) => {
      // The step between password and code lasts minutes; after that the password comes first.
      if (error instanceof ApiError && error.code === "AUTH_CODE_CHALLENGE_EXPIRED") {
        setCodeAsked(false);
        setCode("");
      }
    },
    onSuccess: (next) => {
      if (next === "signed-in") props.onSignedIn();
      else if (next === "code") setCodeAsked(true);
      else props.onAccountCreated(next);
    },
  });

  if (forgot) return <ForgotPassword initialEmail={email} onBack={() => setForgot(false)} />;

  const ready = codeAsked
    ? code.trim() !== ""
    : email.trim().length > 3 &&
      (props.setupRequired ? passwordAccepted(password) : password.length > 0) &&
      (!props.setupTokenRequired || setupToken.trim().length >= 32) &&
      (!props.setupRequired || name.trim() !== "");
  let action = { busy: "Signing in…", idle: "Sign in" };
  if (props.setupRequired) action = { busy: "Creating account…", idle: "Create account" };
  if (codeAsked) action = { busy: "Checking…", idle: "Continue" };
  const problem =
    problemInWords(submit.error) ?? (props.error ? problemInWords(props.error) : null);

  return (
    <AuthScreen
      intro={
        props.setupRequired ? "Create the first account for this Swizzle installation." : undefined
      }
      title={props.setupRequired ? "Set up your instance" : "Sign in"}
    >
      <form
        className="mt-5 grid max-w-[420px] gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && !submit.isPending) submit.mutate();
        }}
      >
        {codeAsked ? (
          <label className="form-label">
            Authentication code
            <input
              autoComplete="one-time-code"
              // biome-ignore lint/a11y/noAutofocus: the field appears because the person must fill it next.
              autoFocus
              className="field h-10"
              onChange={(event) => setCode(event.target.value)}
              spellCheck={false}
              value={code}
            />
            <span className="t-faint font-normal">
              The 6-digit code from your authenticator app, or one of your recovery codes.
            </span>
          </label>
        ) : (
          <>
            {props.setupRequired ? (
              <label className="form-label">
                Name
                <input
                  autoComplete="name"
                  className="field h-10"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
            ) : null}
            {props.setupRequired && props.setupTokenRequired ? (
              <label className="form-label">
                Setup token
                <input
                  autoComplete="off"
                  className="field h-10"
                  onChange={(event) => setSetupToken(event.target.value)}
                  placeholder="From the server configuration"
                  value={setupToken}
                />
              </label>
            ) : null}
            <label className="form-label">
              Email
              <input
                autoComplete="email"
                className="field h-10"
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
            </label>
            {props.setupRequired ? (
              <NewPasswordField
                label="Password"
                note="This account controls the whole instance."
                onChange={setPassword}
                value={password}
              />
            ) : (
              <label className="form-label">
                Password
                <input
                  autoComplete="current-password"
                  className="field h-10"
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  value={password}
                />
              </label>
            )}
            {props.setupRequired ? (
              <TwoFactorChoice checked={offerTwoFactor} onChange={setOfferTwoFactor} />
            ) : null}
          </>
        )}
        {problem ? (
          <p className="errbox m-0 text-[13px]" role="alert">
            {problem}
          </p>
        ) : null}
        <button className="btn mt-1.5 h-10" disabled={!ready || submit.isPending} type="submit">
          {submit.isPending ? action.busy : action.idle}
        </button>
        {!props.setupRequired && !codeAsked && props.mailConfigured ? (
          <button
            className="t-faint justify-self-start underline"
            onClick={() => setForgot(true)}
            type="button"
          >
            Forgot your password?
          </button>
        ) : null}
        <p className="t-faint">
          Access is limited to the people with an account on this instance. To get one, ask an owner
          or admin for an invitation.
        </p>
      </form>
    </AuthScreen>
  );
}

/** Asks for a reset link by mail. The answer is the same whether an account has the address. */
function ForgotPassword(props: { readonly initialEmail: string; readonly onBack: () => void }) {
  const [email, setEmail] = useState(props.initialEmail);
  const send = useMutation({ mutationFn: () => sessionApi.requestPasswordReset(email.trim()) });
  const ready = email.trim().length > 3 && !send.isPending;
  return (
    <AuthScreen
      intro="Swizzle mails a link to set a new password. It works once, for an hour."
      title="Reset your password"
    >
      <form
        className="mt-5 grid max-w-[420px] gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) send.mutate();
        }}
      >
        <label className="form-label">
          Email
          <input
            autoComplete="email"
            className="field h-10"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </label>
        {send.isSuccess ? (
          <p className="m-0 text-[13px]" role="status">
            If an account has this address, the link is on its way.
          </p>
        ) : null}
        {send.isError ? (
          <p className="errbox m-0 text-[13px]" role="alert">
            {problemInWords(send.error)}
          </p>
        ) : null}
        <button className="btn mt-1.5 h-10" disabled={!ready} type="submit">
          {send.isPending ? "Sending…" : "Send reset link"}
        </button>
        <button
          className="t-faint justify-self-start underline"
          onClick={props.onBack}
          type="button"
        >
          Back to sign-in
        </button>
      </form>
    </AuthScreen>
  );
}

/** What a removed or mistyped address shows. */
export function NotFound() {
  return (
    <div className="card mx-auto mt-10 max-w-lg p-6">
      <p className="t-label">Not found</p>
      <h1 className="t-page mt-1.5">
        This page does not <em>exist.</em>
      </h1>
      <p className="t-meta mt-2">
        The dashboard has five places: Overview, Runs, Projects, Credentials and Settings.
      </p>
      <Link className="btn mt-4" to="/">
        Go to the Overview
      </Link>
    </div>
  );
}

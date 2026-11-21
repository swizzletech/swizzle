import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { ApiError } from "../lib/api";
import { sessionApi } from "../lib/api/account";
import {
  DashboardClientProvider,
  useDashboardClient,
  useDashboardSession,
} from "../lib/dashboard-client";
import {
  isAuthStatusRateLimited,
  useAuthStatus,
  useMe,
  useOverview,
  useProjects,
} from "../lib/queries";
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
import { Page } from "./page";
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

  const [onboarding, setOnboarding] = useState<TwoFactorStart | null>(null);
  const enter = () => {
    setOnboarding(null);
    refreshAuth();
    void authQuery.refetch();
  };

  if (onboarding !== null) return <TwoFactorOnboarding onDone={enter} start={onboarding} />;

  if (authQuery.isPending) {
    return (
      <Connecting
        label={
          isAuthStatusRateLimited(authQuery.failureReason) ? "Waiting to check sign-in" : undefined
        }
      />
    );
  }

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

function Frame({ children }: { readonly children: ReactNode }) {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">{children}</main>
    </div>
  );
}

function Connecting({ label = "Connecting to Swizzle" }: { readonly label?: string | undefined }) {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="grid w-64 gap-3">
        <Logo className="brand justify-self-center" />
        <Skeleton label={label} lines={2} />
      </div>
    </div>
  );
}

type Destination = "/" | "/runs" | "/projects" | "/credentials" | "/settings";

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
  let signOutLabel = "Sign out";
  if (signOut.isError) signOutLabel = "Try again";
  if (signOut.isPending) signOutLabel = "Signing out…";

  return (
    <aside className="side">
      <Link aria-label="Swizzle overview" className="brand side-brand" to="/">
        <Logo />
      </Link>
      <nav aria-label="Dashboard" className="side-nav">
        {DESTINATIONS.map((destination) => (
          <Link
            aria-current={isCurrent(pathname, destination.to) ? "page" : undefined}
            className="navlink"
            key={destination.to}
            to={destination.to}
          >
            <Icon>{destination.icon}</Icon>
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
        <label className="envrow">
          <span aria-hidden="true" className="led" />
          <span className="name">{environment}</span>
          {protectedIn.length === 0 ? null : (
            <span
              aria-label="Protected"
              className="lock"
              data-testid="environment-protected"
              role="img"
              title={`Protected in ${protectedIn.map((project) => project.name).join(", ")}: a change needs an environment grant`}
            >
              <Icon>
                <rect height="10" rx="2" width="16" x="4" y="11" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </Icon>
            </span>
          )}
          <Icon>
            <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
          </Icon>
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
        {signOut.isError ? (
          <span className="signout-error" role="alert">
            Not signed out
          </span>
        ) : null}
        <div className="who-row">
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
          <button
            aria-label={signOutLabel}
            className="btn quiet small square"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
            title={signOut.isError ? signOut.error.message : signOutLabel}
            type="button"
          >
            <Icon>
              <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M15 8l4 4-4 4M19 12H9" />
            </Icon>
          </button>
        </div>
      </div>
    </aside>
  );
}

function Icon({ children }: { readonly children: ReactNode }) {
  return (
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
      {children}
    </svg>
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
        className="mt-4 grid gap-3"
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
              className="field"
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
                  className="field"
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
                  className="field"
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
                className="field"
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
                  className="field"
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
          <p className="errbox m-0" role="alert">
            {problem}
          </p>
        ) : null}
        <button className="btn mt-1" disabled={!ready || submit.isPending} type="submit">
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
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) send.mutate();
        }}
      >
        <label className="form-label">
          Email
          <input
            autoComplete="email"
            className="field"
            inputMode="email"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </label>
        {send.isSuccess ? (
          <p className="t-meta m-0" role="status">
            If an account has this address, the link is on its way.
          </p>
        ) : null}
        {send.isError ? (
          <p className="errbox m-0" role="alert">
            {problemInWords(send.error)}
          </p>
        ) : null}
        <button className="btn mt-1" disabled={!ready} type="submit">
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

export function NotFound() {
  return (
    <Page
      actions={
        <Link className="btn" to="/">
          Go to the Overview
        </Link>
      }
      description="The dashboard has five places: Overview, Runs, Projects, Credentials and Settings"
      title="This page does not exist"
      type="reading"
    >
      {null}
    </Page>
  );
}

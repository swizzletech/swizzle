// The pages a mailed link opens, outside the sign-in gate: `/invitation#<token>` creates the
// invited account and `/reset-password#<token>` sets a new password. The token sits in the
// fragment, which the browser never sends to a server, and leaves the address bar and the history
// as soon as the page has read it.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  AuthScreen,
  problemInWords,
  startTwoFactor,
  TwoFactorChoice,
  TwoFactorOnboarding,
  type TwoFactorStart,
} from "../components/auth-screen";
import { Skeleton } from "../components/ui";
import type { InvitationOffer } from "../lib/api";
import { sessionApi } from "../lib/api/account";
import { useDashboardSession } from "../lib/dashboard-client";

const ROLE_IN_WORDS = {
  admin: "an admin, who manages the instance and every project",
  member: "a member",
  owner: "an owner, who manages the instance, every project and its people",
} as const;

/**
 * The one-use token of a mailed link; the address keeps only the path once it is read. A second
 * link opened in the same tab changes only the fragment, so the token follows each hashchange.
 */
function useLinkToken(): string {
  const [token, setToken] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    const read = () => {
      if (window.location.hash === "") return;
      setToken(window.location.hash.slice(1));
      // The router's own entry state stays, so Back and Forward still work.
      window.history.replaceState(window.history.state, "", window.location.pathname);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return token;
}

/** Each token gets a fresh page, so nothing typed or decided for one link carries to the next. */
export function InvitationPage() {
  const token = useLinkToken();
  return <Invitation key={token} token={token} />;
}

export function ResetPasswordPage() {
  const token = useLinkToken();
  return <ResetPassword key={token} token={token} />;
}

function Invitation({ token }: { readonly token: string }) {
  const navigate = useNavigate();
  const { refreshAuth } = useDashboardSession();
  const [onboarding, setOnboarding] = useState<TwoFactorStart | null>(null);
  const offer = useQuery({
    enabled: token !== "",
    queryFn: () => sessionApi.getInvitation(token),
    queryKey: ["invitation", token],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const enter = () => {
    refreshAuth();
    void navigate({ replace: true, to: "/" });
  };

  if (onboarding !== null) return <TwoFactorOnboarding onDone={enter} start={onboarding} />;

  if (token === "" || offer.isError) {
    return (
      <AuthScreen title="This invitation does not work">
        <p className="errbox mt-5 max-w-[420px] text-[13px]" role="alert">
          {token === ""
            ? "The link is incomplete. Open it again from the invitation mail."
            : problemInWords(offer.error)}
        </p>
      </AuthScreen>
    );
  }
  if (offer.data === undefined) {
    return (
      <AuthScreen title="Join Swizzle">
        <div className="mt-5 max-w-[420px]">
          <Skeleton label="Reading the invitation" lines={3} />
        </div>
      </AuthScreen>
    );
  }
  return (
    <AcceptInvitation
      offer={offer.data}
      onAccountCreated={setOnboarding}
      onSignedIn={enter}
      token={token}
    />
  );
}

function AcceptInvitation(props: {
  readonly offer: InvitationOffer;
  readonly token: string;
  readonly onAccountCreated: (start: TwoFactorStart) => void;
  readonly onSignedIn: () => void;
}) {
  const { offer } = props;
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [offerTwoFactor, setOfferTwoFactor] = useState(true);
  const accept = useMutation({
    mutationFn: async () => {
      await sessionApi.acceptInvitation({ email: offer.email, name, password, token: props.token });
      return offerTwoFactor ? await startTwoFactor(password) : null;
    },
    onSuccess: (start) => {
      if (start === null) props.onSignedIn();
      else props.onAccountCreated(start);
    },
  });
  const ready = name.trim() !== "" && password.length >= 15 && !accept.isPending;
  const inviter = offer.invitedBy ?? "An owner";
  return (
    <AuthScreen
      intro={
        <>
          <p className="m-0">
            {inviter} invited you to this Swizzle instance as {ROLE_IN_WORDS[offer.role]}.
          </p>
          {offer.projects.length === 0 ? null : (
            <ul className="mt-2 mb-0 pl-5" data-testid="invitation-projects">
              {offer.projects.map((grant) => (
                <li key={grant.project.id}>
                  {grant.project.name} <span className="t-faint">as {grant.role}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      }
      title="Join Swizzle"
    >
      <form
        className="mt-5 grid max-w-[420px] gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) accept.mutate();
        }}
      >
        <label className="form-label">
          Email
          <input className="field h-10" readOnly type="email" value={offer.email} />
        </label>
        <label className="form-label">
          Name
          <input
            autoComplete="name"
            className="field h-10"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
        <label className="form-label">
          Password
          <input
            autoComplete="new-password"
            className="field h-10"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          <span className="t-faint font-normal">At least 15 characters.</span>
        </label>
        <TwoFactorChoice checked={offerTwoFactor} onChange={setOfferTwoFactor} />
        {accept.isError ? (
          <p className="errbox m-0 text-[13px]" role="alert">
            {problemInWords(accept.error)}
          </p>
        ) : null}
        <button className="btn mt-1.5 h-10" disabled={!ready} type="submit">
          {accept.isPending ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthScreen>
  );
}

function ResetPassword({ token }: { readonly token: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { refreshAuth } = useDashboardSession();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const reset = useMutation({
    mutationFn: async () => {
      if (password !== confirm) throw new Error("The new passwords do not match.");
      await sessionApi.resetPassword({ newPassword: password, token });
    },
    // The reset ended every session of the account, this browser's too, so nothing it had loaded
    // as that person stays.
    onSuccess: () => {
      queryClient.clear();
      refreshAuth();
    },
  });

  if (reset.isSuccess) {
    return (
      <AuthScreen
        intro="Every browser that was signed in to your account is signed out, and your agent tokens are revoked."
        title="Your password is changed"
      >
        <button
          className="btn mt-5 h-10 self-start"
          onClick={() => void navigate({ replace: true, to: "/" })}
          type="button"
        >
          Sign in
        </button>
      </AuthScreen>
    );
  }
  const ready = token !== "" && password.length >= 15 && confirm !== "" && !reset.isPending;
  return (
    <AuthScreen title="Set a new password">
      <form
        className="mt-5 grid max-w-[420px] gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) reset.mutate();
        }}
      >
        <label className="form-label">
          New password
          <input
            autoComplete="new-password"
            className="field h-10"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          <span className="t-faint font-normal">At least 15 characters.</span>
        </label>
        <label className="form-label">
          New password again
          <input
            autoComplete="new-password"
            className="field h-10"
            onChange={(event) => setConfirm(event.target.value)}
            type="password"
            value={confirm}
          />
        </label>
        {token === "" ? (
          <p className="errbox m-0 text-[13px]" role="alert">
            The link is incomplete. Open it again from the mail.
          </p>
        ) : null}
        {reset.isError ? (
          <p className="errbox m-0 text-[13px]" role="alert">
            {problemInWords(reset.error)}
          </p>
        ) : null}
        <button className="btn mt-1.5 h-10" disabled={!ready} type="submit">
          {reset.isPending ? "Saving…" : "Set password"}
        </button>
      </form>
    </AuthScreen>
  );
}

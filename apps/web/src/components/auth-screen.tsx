// The screens a person sees before the dashboard: sign-in and setup (shell.tsx), accepting an
// invitation and resetting a password (routes/account.tsx). Each renders inside AuthScreen, and
// each that sets a password asks for it with NewPasswordField.
//
// Creating an account offers two-factor sign-in, preselected and never required: the form shows
// TwoFactorChoice, its submit calls `startTwoFactor` after the account exists, and the screen then
// renders TwoFactorOnboarding with what that returned.

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { flushSync } from "react-dom";

import { ApiError, type TwoFactorEnrollment } from "../lib/api";
import { sessionApi } from "../lib/api/account";
import { PASSWORD_RULE, passwordProblemInWords, signInProblemInWords } from "../lib/words/access";
import { Logo } from "./logo";
import { RecoveryCodes, TwoFactorSetup } from "./two-factor";

export function AuthScreen(props: {
  readonly title: string;
  readonly intro?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid min-h-screen place-items-center px-4 py-12" data-testid="auth-screen">
      <div className="w-full max-w-[460px]">
        <Logo className="brand mb-5" />
        <main className="card p-7 sm:p-8">
          <h1 className="t-page">{props.title}</h1>
          {props.intro === undefined ? null : <div className="t-meta mt-1.5">{props.intro}</div>}
          {props.children}
        </main>
        <p className="t-faint mt-4 text-center">Agents write it. Swizzle runs it.</p>
      </div>
    </div>
  );
}

/**
 * A new password with its rule underneath. Once a typed password is too short or too long, the rule
 * says by how much and the field is marked invalid, so a form whose button waits for it says why.
 */
export function NewPasswordField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Said after the rule while the password meets it. */
  readonly note?: string;
}) {
  const id = useId();
  const problem = passwordProblemInWords(props.value);
  const rule = props.note === undefined ? PASSWORD_RULE : `${PASSWORD_RULE} ${props.note}`;
  return (
    <div className="form-label">
      <label htmlFor={`${id}-field`}>{props.label}</label>
      <input
        aria-describedby={`${id}-rule`}
        aria-invalid={problem !== null}
        autoComplete="new-password"
        className="field h-10"
        id={`${id}-field`}
        onChange={(event) => props.onChange(event.target.value)}
        type="password"
        value={props.value}
      />
      <span
        className={`font-normal ${problem === null ? "t-faint" : "text-fail"}`}
        id={`${id}-rule`}
      >
        {problem ?? rule}
      </span>
    </div>
  );
}

/** The checkbox on a form that creates an account. It starts checked; unchecking skips the step. */
export function TwoFactorChoice(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 text-[13px]">
      <input
        checked={props.checked}
        className="mt-0.5"
        onChange={(event) => props.onChange(event.target.checked)}
        type="checkbox"
      />
      <span>
        Set up two-factor sign-in next <span className="t-faint">(recommended)</span>
        <span className="t-faint block">
          Sign-in then also asks for a code from an authenticator app. You can skip it on the next
          step and turn it on later in Settings.
        </span>
      </span>
    </label>
  );
}

/** What the step after account creation shows: an enrollment, or why none could start. */
export type TwoFactorStart = TwoFactorEnrollment | { readonly failed: unknown };

/** Starts two-factor setup for the account this browser just created and signed in. */
export async function startTwoFactor(password: string): Promise<TwoFactorStart> {
  try {
    return await sessionApi.enableTwoFactor({ password });
  } catch (error) {
    return { failed: error };
  }
}

/** The step after account creation: the QR code with Skip, then the recovery codes once. */
export function TwoFactorOnboarding(props: {
  readonly start: TwoFactorStart;
  readonly onDone: () => void;
}) {
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  // The secret and the recovery codes are shown once, so a page the browser caches on leaving
  // must not show them again on Back.
  const [left, setLeft] = useState(false);
  useEffect(() => {
    const forget = () => flushSync(() => setLeft(true));
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const { start } = props;
  let body: ReactNode;
  if (left) {
    body = (
      <div className="grid gap-3">
        <p className="t-meta m-0">
          The key and the recovery codes do not show again once you leave this page. Settings shows
          whether two-factor sign-in is on.
        </p>
        <button className="btn justify-self-start" onClick={props.onDone} type="button">
          Continue
        </button>
      </div>
    );
  } else if (codes !== null) {
    body = <RecoveryCodes codes={codes} onDismiss={props.onDone} />;
  } else if ("failed" in start) {
    body = (
      <div className="grid gap-3">
        <p className="errbox m-0 text-[13px]" role="alert">
          Your account is ready, but two-factor setup could not start:{" "}
          {problemInWords(start.failed)}
        </p>
        <button className="btn justify-self-start" onClick={props.onDone} type="button">
          Continue without it
        </button>
      </div>
    );
  } else {
    body = (
      // The form sits in a narrow column here, so its buttons go below the code, not beside it.
      <div className="card rows overflow-hidden [&_.setting]:grid-cols-1">
        <TwoFactorSetup
          cancelLabel="Skip"
          enrollment={start}
          onCancel={props.onDone}
          onConfirmed={() => setCodes(start.backupCodes)}
        />
      </div>
    );
  }
  return (
    <AuthScreen
      intro="Your account is ready. Two-factor sign-in protects it if your password leaks."
      title="Two-factor sign-in"
    >
      <div className="mt-5 max-w-[640px]">{body}</div>
    </AuthScreen>
  );
}

/** The sentence for a failed sign-in or account request. */
export function problemInWords(error: unknown): string | null {
  if (error instanceof ApiError) {
    const words = signInProblemInWords(error.code);
    if (words !== null) return words;
  }
  return error instanceof Error ? error.message : null;
}

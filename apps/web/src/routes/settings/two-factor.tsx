// Settings › Two-factor sign-in (#two-factor): turning it on with an app, its recovery codes, and
// turning it off.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { AuthActionError, RecoveryCodes, TwoFactorSetup } from "../../components/two-factor";
import { Chip, ErrorNote, Skeleton } from "../../components/ui";
import type { TwoFactorEnrollment } from "../../lib/api";
import { sessionApi } from "../../lib/api/account";
import { useDashboardClient } from "../../lib/dashboard-client";
import { SECTION_DATA, Section } from "./section";

export function TwoFactor() {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const status = useQuery({
    meta: SECTION_DATA,
    queryFn: () => api.getTwoFactor(),
    queryKey: ["two-factor"],
  });
  const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // The secret and the recovery codes are shown once, so a page the browser caches on leaving
  // must not show them again on Back.
  useEffect(() => {
    const forget = () =>
      flushSync(() => {
        setEnrollment(null);
        setRecoveryCodes(null);
      });
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const changed = async () => {
    setPassword("");
    setCode("");
    await queryClient.invalidateQueries({ queryKey: ["two-factor"] });
    await queryClient.invalidateQueries({ queryKey: ["sessions"] });
  };
  // The secret and the codes go straight into state, so no mutation result keeps a copy.
  const start = useMutation({
    mutationFn: async () => {
      const started = await sessionApi.enableTwoFactor({ password });
      setPassword("");
      setRecoveryCodes(null);
      setEnrollment(started);
    },
  });
  const disable = useMutation({
    mutationFn: () => api.disableTwoFactor({ code, password }),
    onSuccess: async () => {
      setRecoveryCodes(null);
      await changed();
    },
  });

  const passwordField = (
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
  );
  const codeField = (label: string) => (
    <label className="form-label">
      {label}
      <input
        autoComplete="one-time-code"
        className="field"
        onChange={(event) => setCode(event.target.value)}
        spellCheck={false}
        value={code}
      />
    </label>
  );

  let body: ReactNode;
  if (status.isError) {
    body = (
      <div className="p-4">
        <ErrorNote error={status.error} title="The two-factor state could not be loaded." />
      </div>
    );
  } else if (status.data === undefined) {
    body = <Skeleton label="Loading two-factor sign-in" lines={1} />;
  } else if (enrollment !== null) {
    body = (
      <TwoFactorSetup
        cancelLabel="Cancel"
        enrollment={enrollment}
        onCancel={() => setEnrollment(null)}
        onConfirmed={() => {
          setEnrollment(null);
          setRecoveryCodes(enrollment.backupCodes);
          void changed();
        }}
      />
    );
  } else if (status.data.enabled) {
    const { recoveryCodesLeft } = status.data;
    const ready = password !== "" && code.trim() !== "" && !disable.isPending;
    body = (
      <form
        className="setting-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) disable.mutate();
        }}
      >
        <span className="t-meta basis-full">
          <Chip tone="ok">On</Chip> {recoveryCodesLeft}{" "}
          {recoveryCodesLeft === 1 ? "recovery code" : "recovery codes"} left.
        </span>
        {passwordField}
        {codeField("Code or recovery code")}
        <button className="btn danger" disabled={!ready} type="submit">
          {disable.isPending ? "Turning off…" : "Turn off"}
        </button>
        {disable.isError ? <AuthActionError error={disable.error} /> : null}
      </form>
    );
  } else {
    const ready = password !== "" && !start.isPending;
    body = (
      <form
        className="setting-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) start.mutate();
        }}
      >
        <span className="t-meta basis-full">
          Off. Turn it on when this instance is reachable from the internet.
        </span>
        {passwordField}
        <button className="btn" disabled={!ready} type="submit">
          {start.isPending ? "Preparing…" : "Set up two-factor sign-in"}
        </button>
        {start.isError ? <AuthActionError error={start.error} /> : null}
      </form>
    );
  }

  return (
    <Section
      id="two-factor"
      intro="Sign-in asks for a code from an authenticator app, such as Google Authenticator, 1Password or Aegis, after the password. Turning it on or off signs out every other browser. Agent tokens keep working."
      title="Two-factor sign-in"
    >
      {recoveryCodes === null ? null : (
        <RecoveryCodes codes={recoveryCodes} onDismiss={() => setRecoveryCodes(null)} />
      )}
      <div className="card rows overflow-hidden">{body}</div>
    </Section>
  );
}

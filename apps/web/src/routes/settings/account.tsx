// Settings › Account (`/settings/account`): the password and the browsers signed in.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ActionError } from "../../components/actions";
import { useConfirm } from "../../components/confirm";
import { AuthActionError } from "../../components/two-factor";
import { Chip, ErrorNote, Skeleton, useNow } from "../../components/ui";
import { useDashboardClient } from "../../lib/dashboard-client";
import {
  passwordAccepted,
  passwordProblemInWords,
  sessionDeviceInWords,
} from "../../lib/words/access";
import { ageInWords } from "../../lib/words/time";
import { Section } from "./section";

export function Account() {
  const confirm = useConfirm();
  const { api, refreshAuth } = useDashboardClient();
  const queryClient = useQueryClient();
  const now = useNow();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const twoFactor = useQuery({
    queryFn: () => api.getTwoFactor(),
    queryKey: ["two-factor"],
  });
  const needsCode = twoFactor.data?.enabled === true;
  const changePassword = useMutation({
    mutationFn: () => {
      if (next !== repeat) throw new Error("The new passwords do not match.");
      return api.changePassword({ code, currentPassword: current, newPassword: next });
    },
    onSuccess: async () => {
      setCurrent("");
      setNext("");
      setRepeat("");
      setCode("");
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["two-factor"] });
    },
  });
  const problem = passwordProblemInWords(next);
  const ids = useId();
  // Until the two-factor state is known, the form cannot tell whether it needs a code.
  const ready =
    twoFactor.data !== undefined &&
    current !== "" &&
    passwordAccepted(next) &&
    (!needsCode || code.trim() !== "") &&
    !changePassword.isPending;
  const sessions = useQuery({
    queryFn: () => api.listSessions(),
    queryKey: ["sessions"],
  });
  const revoke = useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });
  const signOutAll = useMutation({
    mutationFn: () => api.revokeAllSessions(),
    onSuccess: () => {
      queryClient.clear();
      refreshAuth();
    },
  });
  const signOut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      refreshAuth();
    },
  });
  return (
    <Section
      intro="Changing the password signs out every other browser. Agent tokens keep working until you revoke them."
      title="Account"
    >
      <div className="card rows overflow-hidden">
        <form
          className="setting-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) changePassword.mutate();
          }}
        >
          <label className="form-label min-w-[130px] flex-1">
            Current password
            <input
              autoComplete="current-password"
              className="field"
              onChange={(event) => setCurrent(event.target.value)}
              type="password"
              value={current}
            />
          </label>
          <label className="form-label min-w-[130px] flex-1">
            New password
            <input
              aria-describedby={problem === null ? undefined : `${ids}-rule`}
              aria-invalid={problem !== null}
              autoComplete="new-password"
              className="field"
              onChange={(event) => setNext(event.target.value)}
              type="password"
              value={next}
            />
          </label>
          <label className="form-label min-w-[130px] flex-1">
            Repeat new password
            <input
              autoComplete="new-password"
              className="field"
              onChange={(event) => setRepeat(event.target.value)}
              type="password"
              value={repeat}
            />
          </label>
          {needsCode ? (
            <label className="form-label min-w-[130px] flex-1">
              Code or recovery code
              <input
                autoComplete="one-time-code"
                className="field"
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
                value={code}
              />
            </label>
          ) : null}
          <button className="btn" disabled={!ready} type="submit">
            Change password
          </button>
          {problem === null ? null : (
            <span className="basis-full text-[12.5px] text-fail" id={`${ids}-rule`}>
              {problem}
            </span>
          )}
          {changePassword.isError ? <AuthActionError error={changePassword.error} /> : null}
          {changePassword.isSuccess ? (
            <span className="basis-full text-right text-[12.5px]" role="status">
              Password changed. Every other browser is signed out.
            </span>
          ) : null}
          {twoFactor.isError ? <ActionError error={twoFactor.error} /> : null}
        </form>
        {sessions.isError ? (
          <div className="p-4">
            <ErrorNote error={sessions.error} title="The signed-in browsers could not be loaded." />
          </div>
        ) : sessions.data === undefined ? (
          <Skeleton label="Loading signed-in browsers" lines={1} />
        ) : (
          sessions.data.sessions.map((session) => {
            const device = sessionDeviceInWords(session.userAgent);
            return (
              <div className="setting" data-testid="session" key={session.id}>
                <span className="grid gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <b title={session.userAgent ?? undefined}>{device}</b>
                    {session.current ? <Chip tone="ok">This browser</Chip> : null}
                  </span>
                  <span className="t-meta">
                    Signed in {ageInWords(session.createdAt, now)}, last seen{" "}
                    {ageInWords(session.lastSeenAt, now)}.
                  </span>
                </span>
                {session.current ? null : (
                  <button
                    aria-label={`Sign out ${device}`}
                    className="btn quiet"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(session.id)}
                    type="button"
                  >
                    Sign out
                  </button>
                )}
              </div>
            );
          })
        )}
        <div className="setting">
          <span className="t-meta">Signed in on a device you no longer use?</span>
          <div className="flex gap-2">
            <button
              className="btn quiet"
              disabled={signOutAll.isPending}
              onClick={async () => {
                const question = "Sign out every browser, including this one?";
                if (await confirm({ action: "Sign out all", question })) signOutAll.mutate();
              }}
              type="button"
            >
              Sign out all sessions
            </button>
            <button
              className="btn quiet"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
              type="button"
            >
              Sign out
            </button>
          </div>
        </div>
        {revoke.isError || signOutAll.isError || signOut.isError ? (
          <div className="px-[18px] py-2">
            <ActionError error={revoke.error ?? signOutAll.error ?? signOut.error} />
          </div>
        ) : null}
      </div>
    </Section>
  );
}

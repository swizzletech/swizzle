// Setting up two-factor sign-in, shared by Settings › Two-factor sign-in and the step after an
// account is created. `sessionApi.enableTwoFactor` returns the enrollment; TwoFactorSetup shows
// its QR code and confirms a code from the app; RecoveryCodes shows the codes once.

import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiError, type TwoFactorEnrollment } from "../lib/api";
import { sessionApi } from "../lib/api/account";
import { signInProblemInWords } from "../lib/words/access";
import { ActionError } from "./actions";
import { CopyButton } from "./ui";

/** An action's error, in the words the dashboard has for sign-in and account codes. */
export function AuthActionError(props: { readonly error: unknown }) {
  const words = props.error instanceof ApiError ? signInProblemInWords(props.error.code) : null;
  return <ActionError error={words === null ? props.error : new Error(words)} />;
}

/** The QR code and key of an enrollment, and the code that turns two-factor sign-in on. */
export function TwoFactorSetup(props: {
  readonly enrollment: TwoFactorEnrollment;
  readonly cancelLabel: string;
  readonly onCancel: () => void;
  readonly onConfirmed: () => void;
}) {
  const [code, setCode] = useState("");
  const confirm = useMutation({
    mutationFn: () => sessionApi.confirmTwoFactor(code),
    onSuccess: props.onConfirmed,
  });
  const secret = new URL(props.enrollment.totpURI).searchParams.get("secret") ?? "";
  const ready = code.trim() !== "" && !confirm.isPending;
  return (
    <form
      className="setting items-start"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) confirm.mutate();
      }}
    >
      <div className="flex flex-wrap items-start gap-5">
        <QrCode text={props.enrollment.totpURI} />
        <div className="grid max-w-[420px] gap-3">
          <p className="t-meta m-0">
            Scan the code with your authenticator app, then confirm with the code the app shows. No
            camera? Enter this key:
          </p>
          <code className="mono break-all" data-testid="two-factor-key">
            {secret.match(/.{1,4}/gu)?.join(" ")}
          </code>
          <div className="flex flex-wrap items-end gap-3">
            <label className="form-label">
              Code from the app
              <input
                autoComplete="one-time-code"
                className="field"
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
                value={code}
              />
            </label>
            {confirm.isError ? <AuthActionError error={confirm.error} /> : null}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <button className="btn" disabled={!ready} type="submit">
          {confirm.isPending ? "Confirming…" : "Turn on"}
        </button>
        <button
          className="btn quiet"
          disabled={confirm.isPending}
          onClick={props.onCancel}
          type="button"
        >
          {props.cancelLabel}
        </button>
      </div>
    </form>
  );
}

/** The one-time block with the recovery codes, each of which signs in once without the app. */
export function RecoveryCodes(props: {
  readonly codes: readonly string[];
  readonly onDismiss: () => void;
}) {
  const text = props.codes.join("\n");
  return (
    <div className="card mb-3.5 grid gap-3 px-5 py-4" data-testid="recovery-codes">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="t-section">Save your recovery codes</h3>
        <span className="t-faint">
          They are shown only now. Each one signs you in once if you lose your authenticator app.
        </span>
      </div>
      <pre className="screen">{text}</pre>
      <div className="flex gap-2">
        <CopyButton label="Copy codes" text={text} />
        <button className="btn quiet" onClick={props.onDismiss} type="button">
          I saved them
        </button>
      </div>
    </div>
  );
}

/** Draws `text` as a QR code. The encoder loads only when a person sets up two-factor sign-in. */
function QrCode({ text }: { readonly text: string }) {
  const [modules, setModules] = useState<
    { readonly path: string; readonly size: number } | "failed" | null
  >(null);
  useEffect(() => {
    let current = true;
    import("lean-qr")
      .then(({ generate }) => {
        const code = generate(text);
        let path = "";
        for (let y = 0; y < code.size; y += 1) {
          for (let x = 0; x < code.size; x += 1) if (code.get(x, y)) path += `M${x} ${y}h1v1h-1z`;
        }
        if (current) setModules({ path, size: code.size });
      })
      // A chunk that fails to load, after a deployment or on a dropped connection, leaves the key.
      .catch(() => {
        if (current) setModules("failed");
      });
    return () => {
      current = false;
    };
  }, [text]);
  if (modules === "failed") {
    return (
      <p className="t-meta m-0 grid h-[200px] w-[200px] shrink-0 place-items-center text-center">
        The QR code could not be drawn. Enter the key instead.
      </p>
    );
  }
  if (modules === null) return <div className="h-[200px] w-[200px] shrink-0" />;
  // Scanners need dark modules on a light ground in either colour scheme, so the colours are fixed.
  return (
    <svg
      aria-label="QR code for your authenticator app"
      className="h-[200px] w-[200px] shrink-0 rounded"
      data-testid="two-factor-qr"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`-4 -4 ${modules.size + 8} ${modules.size + 8}`}
    >
      <rect fill="#fff" height={modules.size + 8} width={modules.size + 8} x={-4} y={-4} />
      <path d={modules.path} fill="#000" />
    </svg>
  );
}

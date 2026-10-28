// The dashboard's small parts: status marks, loading and error states, copy, and the brand mark.
// Their look lives in styles.css under the same class names; these components add only behaviour
// and words.

import { type ReactNode, useEffect, useState } from "react";

import { ApiError, type RunStatus } from "../lib/api";
import { accessProblemInWords } from "../lib/words/access";
import { RUN_TONE, type Tone } from "../lib/words/health";

export function Dot(props: { readonly tone: Tone; readonly className?: string }) {
  return <span aria-hidden="true" className={`dot ${props.tone} ${props.className ?? ""}`} />;
}

export function Chip(props: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <span className={`chip ${props.tone}`}>
      <Dot tone={props.tone} />
      {props.children}
    </span>
  );
}

const STRIP_LENGTH = 10;

/** The last 10 runs as bars, oldest left; slots without a run stay empty on the left. */
export function HealthStrip(props: { readonly runs: readonly { readonly status: RunStatus }[] }) {
  const oldestFirst = props.runs.slice(0, STRIP_LENGTH).toReversed();
  const empty = STRIP_LENGTH - oldestFirst.length;
  const failed = oldestFirst.filter((run) => RUN_TONE[run.status] === "fail").length;
  const label =
    oldestFirst.length === 0
      ? "No runs yet"
      : oldestFirst.length === 1
        ? `Last run ${failed === 0 ? "did not fail" : "failed"}`
        : `Last ${oldestFirst.length} runs, ${failed === 0 ? "none" : failed} failed`;
  return (
    <span aria-label={label} className="strip" role="img" title={label}>
      {Array.from({ length: empty }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: empty slots are positional
        <i key={`empty-${index}`} />
      ))}
      {oldestFirst.map((run, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional
        <i className={RUN_TONE[run.status]} key={`run-${index}`} />
      ))}
    </span>
  );
}

export function Skeleton(props: { readonly lines?: number; readonly label?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={props.label ?? "Loading"}
      className="grid gap-2 p-4"
      role="status"
    >
      {Array.from({ length: props.lines ?? 3 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder lines are positional
        <div className="skeleton h-4" key={index} style={{ width: `${90 - index * 12}%` }} />
      ))}
    </div>
  );
}

/** A failed request in words; a refused right says what it needs and where the person's role comes from. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return accessProblemInWords(error) ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/** A failed request, said as one: never an empty list. */
export function ErrorNote(props: {
  readonly error: unknown;
  readonly title: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="errbox" role="alert">
      <b>{props.title}</b>
      <p className="mt-1 text-[13px]">{errorText(props.error)}</p>
      {props.onRetry ? (
        <button className="btn quiet small mt-2" onClick={props.onRetry} type="button">
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * Copies `text` and says so for two seconds. Where the browser refuses (plain HTTP has no
 * clipboard, or permission is denied) or does not answer within a second and a half, it shows the
 * text selected with a note, so the owner copies it by hand. In a parent that wraps, the text
 * takes the last row.
 */
export function CopyButton(props: {
  readonly text: string;
  readonly label: string;
  readonly className?: string;
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "by-hand">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    setState("copying");
    let timer = 0;
    const silence = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error("The clipboard did not answer.")), 1_500);
    });
    try {
      await Promise.race([navigator.clipboard.writeText(props.text), silence]);
      setState("copied");
    } catch {
      setState("by-hand");
    } finally {
      window.clearTimeout(timer);
    }
  };
  return (
    <>
      {/* Disabled while the clipboard is asked, so a late answer cannot overwrite a newer one. */}
      <button
        className={props.className ?? "btn"}
        disabled={state === "copying"}
        onClick={() => void copy()}
        type="button"
      >
        {state === "copied" ? "Copied" : props.label}
      </button>
      {state === "by-hand" ? (
        <span className="order-last grid basis-full gap-1.5">
          <span className="text-[12.5px]" role="alert">
            The browser did not copy it. The text below is selected: press Ctrl+C or ⌘C.
          </span>
          <textarea
            aria-label={`${props.label}: copy this text`}
            className="field mono text-[12px]"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            ref={focusOnMount}
            rows={4}
            value={props.text}
          />
        </span>
      ) : null}
    </>
  );
}

/** A ref callback that is the same function on every render, so it focuses only when the node mounts. */
function focusOnMount(node: HTMLElement | null): void {
  node?.focus();
}

/** True below the 900 px breakpoint the stylesheets use, where layouts go to one column. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return phone;
}

const PHONE_QUERY = "(max-width: 900px)";

/** Re-renders every `intervalMs`, so ages such as "4 min ago" stay true on an open page. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Text whose `backticked` parts are commands, set in mono. */
export function WithCode(props: { readonly text: string }) {
  return props.text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
      <span className="mono" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/** A section heading with an optional note on the right. */
export function SectionHead(props: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="sec-head">
      <h2 className="t-section">{props.title}</h2>
      {props.children}
    </div>
  );
}

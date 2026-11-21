import { type ReactNode, useEffect, useState } from "react";

import { ApiError } from "../lib/api";
import { accessProblemInWords } from "../lib/words/access";
import type { Tone } from "../lib/words/health";

export function Dot(props: { readonly tone: Tone; readonly className?: string }) {
  return <span aria-hidden="true" className={`dot ${props.tone} ${props.className ?? ""}`} />;
}

export function Chip(props: { readonly tone: Tone; readonly children: ReactNode }) {
  return <span className={`chip ${props.tone}`}>{props.children}</span>;
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

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return accessProblemInWords(error) ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

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
      <button
        className={props.className ?? "btn"}
        disabled={state === "copying"}
        onClick={() => void copy()}
        type="button"
      >
        {state === "copied" ? "Copied" : props.label}
      </button>
      {state === "by-hand" ? (
        <span className="order-last grid basis-full gap-2">
          <span className="text-[13px]" role="alert">
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

function focusOnMount(node: HTMLElement | null): void {
  node?.focus();
}

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

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

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

export function SectionHead(props: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <div className="sec-head">
      <h2 className="t-section">{props.title}</h2>
      {props.children}
    </div>
  );
}

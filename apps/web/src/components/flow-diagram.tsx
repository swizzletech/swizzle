import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";

import { ErrorNote, Skeleton } from "./ui";

let renderCount = 0;

async function renderDiagram(code: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string) => tokens.getPropertyValue(name).trim();
  mermaid.initialize({
    htmlLabels: false,
    layout: "dagre",
    look: "classic",
    securityLevel: "strict",
    startOnLoad: false,
    theme: "base",
    themeVariables: {
      background: "transparent",
      fontFamily: token("--font-sans") || "system-ui, sans-serif",
      fontSize: "13px",
      lineColor: token("--ink-3"),
      mainBkg: token("--raised"),
      primaryBorderColor: token("--ink-3"),
      primaryColor: token("--raised"),
      primaryTextColor: token("--ink"),
    },
  });
  const { svg } = await mermaid.render(`swizzle-flow-${renderCount++}`, code);
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

export function FlowDiagram(props: { readonly code: string }) {
  const target = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ readonly error: unknown } | "drawing" | "drawn">("drawing");

  useEffect(() => {
    let cancelled = false;
    if (target.current !== null) target.current.innerHTML = "";
    setState("drawing");
    renderDiagram(props.code).then(
      (svg) => {
        if (cancelled || target.current === null) return;
        target.current.innerHTML = svg;
        setState("drawn");
      },
      (error: unknown) => {
        if (!cancelled) setState({ error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [props.code]);

  return (
    <>
      {state === "drawing" ? <Skeleton label="Drawing the flow" lines={3} /> : null}
      {typeof state === "object" ? (
        <ErrorNote error={state.error} title="The flow diagram could not be drawn" />
      ) : null}
      <div
        aria-label="Flow diagram"
        className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
        data-testid="flow-diagram"
        ref={target}
        role="img"
      />
    </>
  );
}

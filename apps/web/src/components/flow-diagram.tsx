// The flow diagram an automation ships as Mermaid source, drawn on its About tab. Mermaid loads on
// the first diagram only, and the diagram takes the colour tokens of `styles.css` in the mode the
// system is in when it is drawn.

import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";

import { ErrorNote, Skeleton } from "./ui";

let renderCount = 0;

async function renderDiagram(code: string): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  // Mermaid needs literal colours, so read the tokens' current values.
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string) => tokens.getPropertyValue(name).trim();
  mermaid.initialize({
    // DOMPurify strips HTML labels from the SVG, so labels are drawn as SVG text.
    htmlLabels: false,
    // Mermaid 12 defaults to the ELK layout, a 450 kB gzip chunk; dagre is 17 kB.
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
    // An old drawing must not stand in for new source that fails to draw.
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
        <ErrorNote error={state.error} title="The flow diagram could not be drawn." />
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

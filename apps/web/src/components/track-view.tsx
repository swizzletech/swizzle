import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

const EDGES = {
  down: { arrow: "↓", left: 0, top: 1 },
  left: { arrow: "←", left: -1, top: 0 },
  right: { arrow: "→", left: 1, top: 0 },
  up: { arrow: "↑", left: 0, top: -1 },
} as const;
type Edge = keyof typeof EDGES;

const PRESS = 0.75;

function clippedEdges(view: HTMLElement): string {
  const { clientHeight, clientWidth, scrollHeight, scrollLeft, scrollTop, scrollWidth } = view;
  return [
    scrollLeft > 1 ? "left" : "",
    scrollWidth - clientWidth - scrollLeft > 1 ? "right" : "",
    scrollTop > 1 ? "up" : "",
    scrollHeight - clientHeight - scrollTop > 1 ? "down" : "",
  ]
    .filter((edge) => edge !== "")
    .join(" ");
}

export function TrackView(props: {
  readonly children: ReactNode;
  readonly focused: string | null;
}) {
  const view = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const [clipped, setClipped] = useState("");

  useLayoutEffect(() => {
    const element = view.current;
    if (element === null) return;
    const measure = () => setClipped(clippedEdges(element));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `focused` says when to look again.
  useLayoutEffect(() => {
    const element = view.current;
    const station = element?.querySelector('[aria-current="step"]');
    if (!element || !station) return;
    const port = element.getBoundingClientRect();
    const box = station.getBoundingClientRect();
    const inside =
      box.left >= port.left &&
      box.right <= port.right &&
      box.top >= port.top &&
      box.bottom <= port.bottom;
    if (!inside) {
      element.scrollTo({
        behavior: opened.current ? "smooth" : "auto",
        left: element.scrollLeft + box.left - port.left - (port.width - box.width) / 2,
        top: element.scrollTop + box.top - port.top - (port.height - box.height) / 2,
      });
    }
    opened.current = true;
  }, [props.focused]);

  return (
    <div className="track-view">
      <div className="track-scroll" ref={view}>
        {props.children}
      </div>
      {(Object.keys(EDGES) as Edge[])
        .filter((edge) => clipped.split(" ").includes(edge))
        .map((edge) => (
          <div className={`track-edge ${edge}`} key={edge}>
            <button
              aria-label={`Scroll ${edge}`}
              className="btn quiet small square"
              data-testid="track-more"
              onClick={() => {
                const element = view.current;
                element?.scrollBy({
                  behavior: "smooth",
                  left: EDGES[edge].left * element.clientWidth * PRESS,
                  top: EDGES[edge].top * element.clientHeight * PRESS,
                });
              }}
              type="button"
            >
              {EDGES[edge].arrow}
            </button>
          </div>
        ))}
    </div>
  );
}

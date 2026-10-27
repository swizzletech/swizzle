// Every menu that opens under its button draws this component, so all of them close the same way:
// on a click outside the menu and on Escape, and only one is open at a time. Escape returns focus
// to the button. A click outside on another control leaves focus there; one on the page itself
// returns it to the button. An open menu stays on screen: a body that would run past the edge of
// a narrow screen moves back inside and shrinks to the screen's width.

import { type ReactNode, useEffect, useRef } from "react";

import "./menu.css";

/** The gap an open menu keeps to the edges of the screen, in px. */
const SCREEN_EDGE = 8;

export function Menu(props: {
  /** What the button shows. */
  readonly button: ReactNode;
  /** The button's accessible name, for a button that shows only a symbol. */
  readonly label?: string;
  readonly buttonClassName: string;
  readonly bodyClassName?: string;
  /** Opens toward the right from the button's left edge instead of toward the left. */
  readonly alignStart?: boolean;
  readonly children: ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = details.current;
    const panel = body.current;
    if (menu === null || panel === null) return;
    let dismissed = false;
    const onPointerDown = (event: PointerEvent) => {
      dismissed = menu.open && event.target instanceof Node && !menu.contains(event.target);
      if (dismissed) menu.open = false;
    };
    // The click comes after the browser moved focus for the press, which a touch does only on
    // release, so the body holding focus here means the press landed on nothing focusable.
    const onClick = () => {
      if (dismissed && document.activeElement === document.body) summary.current?.focus();
      dismissed = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!menu.open || event.key !== "Escape") return;
      menu.open = false;
      summary.current?.focus();
    };
    // The body hangs from its button, so on a narrow screen it can start or end off screen.
    const onToggle = () => {
      panel.style.translate = "";
      if (!menu.open) return;
      const screen = document.documentElement.clientWidth;
      panel.style.maxWidth = `${screen - 2 * SCREEN_EDGE}px`;
      const { left, right } = panel.getBoundingClientRect();
      const shift = Math.max(SCREEN_EDGE - left, Math.min(0, screen - SCREEN_EDGE - right));
      if (shift !== 0) panel.style.translate = `${shift}px`;
    };
    menu.addEventListener("toggle", onToggle);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      menu.removeEventListener("toggle", onToggle);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  // Details that share a name open one at a time, so opening a menu closes the one already open.
  return (
    <details className={props.alignStart ? "menu start" : "menu"} name="menu" ref={details}>
      <summary aria-label={props.label} className={props.buttonClassName} ref={summary}>
        {props.button}
      </summary>
      <div className={`menu-body surface-glass ${props.bodyClassName ?? ""}`} ref={body}>
        {props.children}
      </div>
    </details>
  );
}

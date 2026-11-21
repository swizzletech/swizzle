import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";

import "./menu.css";

const SCREEN_EDGE = 8;

export function Menu(props: {
  readonly button: ReactNode;
  readonly label?: string;
  readonly buttonClassName: string;
  readonly bodyClassName?: string;
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
    const onClick = () => {
      if (dismissed && document.activeElement === document.body) summary.current?.focus();
      dismissed = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!menu.open || event.key !== "Escape") return;
      menu.open = false;
      summary.current?.focus();
    };
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

export function MenuItem(props: {
  readonly children: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly expanded?: boolean;
  readonly onClick: () => void;
}) {
  const choose = (event: MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    props.onClick();
  };
  return (
    <button
      aria-expanded={props.expanded}
      className={props.danger === true ? "menu-item danger" : "menu-item"}
      disabled={props.disabled}
      onClick={choose}
      type="button"
    >
      {props.children}
    </button>
  );
}

export function RowMenu({ children }: { readonly children: ReactNode }) {
  return (
    <Menu
      bodyClassName="menu-actions"
      button="⋯"
      buttonClassName="btn quiet small square"
      label="More"
    >
      {children}
    </Menu>
  );
}

// One page of the dashboard: the shared head (a small path on deep pages, the title, a description
// and the actions), an optional tab bar, then the page's content. A page is one of four types:
// `overview` shows state at a glance, `workbench` fills the window with panes that scroll on their
// own, `reading` is a document and its facts, and `administration` is rows and forms to change.
// Every page renders this; a route passes what its head shows while its data still loads, too.

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import "./page.css";

export type PageType = "overview" | "workbench" | "reading" | "administration";

export function Page(props: {
  readonly type: PageType;
  readonly title: ReactNode;
  /** A short fact beside the title, such as how many runs are loaded. */
  readonly note?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  /** Where a deep page sits: its parent as a link, then its own name. */
  readonly path?: {
    readonly parent: { readonly label: string; readonly to: "/" | "/projects" | "/settings" };
    readonly current: string;
  };
  /** The underline tabs of the page's views. */
  readonly tabs?: ReactNode;
  readonly children: ReactNode;
}) {
  const { path } = props;
  return (
    <div className="page" data-page-type={props.type}>
      <header className="page-head" data-testid="page-head">
        <div className="page-title">
          {path === undefined ? null : (
            <nav aria-label="Trail" className="page-path">
              <Link to={path.parent.to}>{path.parent.label}</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page" className="truncate">
                {path.current}
              </span>
            </nav>
          )}
          <div className="page-name">
            <h1 className="t-page">{props.title}</h1>
            {props.note === undefined ? null : <span className="t-faint">{props.note}</span>}
          </div>
          {props.description === undefined ? null : (
            <div className="page-description">{props.description}</div>
          )}
        </div>
        {props.actions === undefined ? null : <div className="page-actions">{props.actions}</div>}
      </header>
      {props.tabs}
      {props.type === "workbench" ? (
        props.children
      ) : (
        <div className="page-body">
          <div className="page-content stack">{props.children}</div>
        </div>
      )}
    </div>
  );
}

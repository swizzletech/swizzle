import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import "./page.css";

export type PageType = "overview" | "workbench" | "reading" | "administration";

export function Page(props: {
  readonly type: PageType;
  readonly title: ReactNode;
  readonly note?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly path?: {
    readonly parent: { readonly label: string; readonly to: "/" | "/projects" | "/settings" };
    readonly current: string;
  };
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

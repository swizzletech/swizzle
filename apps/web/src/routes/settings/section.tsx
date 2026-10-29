// The frame of a Settings section, which is a page of its own: its title and intro.

import type { ReactNode } from "react";

export function Section(props: {
  readonly title: string;
  readonly intro: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <div className="sec-head">
        <h1 className="t-page">{props.title}</h1>
        <p className="t-meta mt-1">{props.intro}</p>
      </div>
      {props.children}
    </section>
  );
}

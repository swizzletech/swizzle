// The frame of a Settings section: its anchor, title and intro.

import type { ReactNode } from "react";

export function Section(props: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="scroll-mt-6" id={props.id}>
      <div className="sec-head">
        <h2 className="t-section">{props.title}</h2>
        <p className="t-meta mt-1">{props.intro}</p>
      </div>
      {props.children}
    </section>
  );
}

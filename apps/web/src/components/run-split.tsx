// A list of runs beside the chosen run, as Runs and an automation's Runs tab show them. A phone has
// no beside, and beside a long list it would put the run far down: it shows the list, or the run
// once the address names one, with a button back to the list. useRunSplit decides what is on
// screen, and RunSplit lays it out; a page that places more around the list, such as the track,
// reads the same view.

import type { ReactNode } from "react";

import { usePhone } from "./ui";

export interface RunSplitView {
  /** The run the address names, else the first in the list. */
  readonly selected: string | undefined;
  /** Whether the list is on screen. */
  readonly list: boolean;
  /** The run on screen, if any. */
  readonly run: string | undefined;
}

/** `opened` is the run the address names; `first` is the first run of the list. */
export function useRunSplit(opened: string | undefined, first: string | undefined): RunSplitView {
  const phone = usePhone();
  const selected = opened ?? first;
  return {
    list: !phone || opened === undefined,
    run: !phone || opened !== undefined ? selected : undefined,
    selected,
  };
}

export function RunSplit(props: {
  readonly view: RunSplitView;
  /** Takes the run out of the address, which shows the list again. */
  readonly onBack: () => void;
  readonly list: ReactNode;
  readonly run: (runId: string) => ReactNode;
}) {
  const { view } = props;
  return (
    <div className={view.list && view.run !== undefined ? "split" : undefined}>
      {view.list ? (
        props.list
      ) : (
        <button className="btn quiet small mb-3" onClick={props.onBack} type="button">
          ← All runs
        </button>
      )}
      {view.run === undefined ? null : props.run(view.run)}
    </div>
  );
}

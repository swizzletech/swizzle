// The one confirmation every irreversible or disruptive action asks before it acts: revoking a
// token or a worker, deleting, rolling back, signing out every browser. A browser or an agent's
// webview may suppress window.confirm and answer false at once, so the dashboard never calls it
// and asks in a dialog of its own instead.
//
//   const confirm = useConfirm();
//   if (await confirm({ question: `Revoke ${name}?`, action: "Revoke" })) revoke.mutate(id);
//
// ConfirmProvider in main.tsx owns the one dialog. Cancel, Escape and a click outside it answer
// false; only the action button answers true.

import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

export interface ConfirmRequest {
  /** What happens, as a question the person answers: "Revoke Claude? The agent loses access." */
  readonly question: string;
  /** The button that goes ahead: "Revoke", "Delete", "Roll back". */
  readonly action: string;
}

type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

/** Asks in the page; resolves true only when the person chose the action. */
export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext);
  if (confirm === null) throw new Error("useConfirm needs a ConfirmProvider above it.");
  return confirm;
}

export function ConfirmProvider(props: { readonly children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [asked, setAsked] = useState<{
    readonly request: ConfirmRequest;
    readonly answer: (yes: boolean) => void;
  } | null>(null);
  const confirm = useCallback<Confirm>(
    (request) =>
      new Promise<boolean>((resolve) => {
        const sheet = dialog.current;
        // The open dialog makes the rest of the page inert, so nothing else asks meanwhile.
        if (sheet === null || sheet.open) return resolve(false);
        sheet.returnValue = "";
        // Rendered before it opens, so the dialog focuses Cancel, its first button.
        flushSync(() => setAsked({ answer: resolve, request }));
        sheet.showModal();
      }),
    [],
  );
  return (
    <ConfirmContext value={confirm}>
      {props.children}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click handler only catches the backdrop; Escape closes the dialog natively. */}
      <dialog
        aria-labelledby="confirm-question"
        className="sheet surface-glass"
        onClick={(event) => {
          if (clickedBackdrop(event)) event.currentTarget.close();
        }}
        onClose={(event) => {
          asked?.answer(event.currentTarget.returnValue === "confirm");
          setAsked(null);
        }}
        ref={dialog}
      >
        {asked === null ? null : (
          <form className="grid gap-4" method="dialog">
            <p className="m-0" id="confirm-question">
              {asked.request.question}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button className="btn quiet" type="submit" value="cancel">
                Cancel
              </button>
              <button className="btn danger" type="submit" value="confirm">
                {asked.request.action}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </ConfirmContext>
  );
}

/**
 * Whether a click on a modal dialog landed on its backdrop: the backdrop reports the dialog itself
 * as the target, outside its box. A keyboard click on a button inside reports (0, 0), outside the
 * box too, so only the target check tells it apart.
 */
export function clickedBackdrop(event: MouseEvent<HTMLDialogElement>): boolean {
  const sheet = event.currentTarget;
  const box = sheet.getBoundingClientRect();
  return (
    event.target === sheet &&
    (event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom)
  );
}

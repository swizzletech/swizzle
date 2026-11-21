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
  readonly question: string;
  readonly action: string;
}

type Confirm = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Confirm | null>(null);

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
        if (sheet === null || sheet.open) return resolve(false);
        sheet.returnValue = "";
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

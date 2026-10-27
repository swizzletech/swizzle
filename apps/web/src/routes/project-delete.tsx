// Deleting a project (ADR 0015): a dialog that shows what the project holds and asks what happens
// to it. Its automations, credentials and runs move to another project the person administers,
// or they are deleted with it, confirmed by typing the project's short name. An empty project
// goes after a plain confirm. Audit events stay either way, as the dialog says. The delete in
// flight belongs to the button, not the form: the dialog stays open while it runs, and reopening
// it after a forced close shows it still running.

import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";

import { ActionError } from "../components/actions";
import { ErrorNote, Skeleton } from "../components/ui";
import type { Project, ProjectContentCounts, ProjectContentsChoice } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import "./project-delete.css";

type Removal = UseMutationResult<unknown, Error, ProjectContentsChoice | null>;

/** The button that opens the dialog, for a project's admins. */
export function DeleteProject(props: {
  readonly project: Project;
  readonly projects: readonly Project[];
}) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: (choice: ProjectContentsChoice | null) =>
      api.deleteProject(props.project.slug, choice),
    // Leave the page first, so it never renders the project as missing.
    onSuccess: async () => {
      await navigate({ to: "/projects" });
      await queryClient.invalidateQueries();
    },
  });
  return (
    <>
      <button
        className="btn danger small"
        onClick={() => {
          if (!remove.isPending) remove.reset();
          setOpen(true);
          dialog.current?.showModal();
        }}
        type="button"
      >
        Delete project
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click handler only catches the backdrop; Escape closes the dialog natively. */}
      <dialog
        aria-labelledby="delete-project-title"
        className="sheet surface-glass"
        onCancel={(event) => {
          if (remove.isPending) event.preventDefault();
        }}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog itself, outside its box. A keyboard click
          // on a button inside reports (0, 0), so the target check keeps it from closing the sheet.
          const sheet = event.currentTarget;
          const box = sheet.getBoundingClientRect();
          const outside =
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom;
          if (event.target === sheet && outside && !remove.isPending) sheet.close();
        }}
        onClose={() => setOpen(false)}
        ref={dialog}
      >
        {open ? (
          <DeleteProjectForm
            onCancel={() => dialog.current?.close()}
            project={props.project}
            remove={remove}
            targets={props.projects.filter(
              (candidate) => candidate.id !== props.project.id && candidate.role === "admin",
            )}
          />
        ) : null}
      </dialog>
    </>
  );
}

function DeleteProjectForm(props: {
  readonly onCancel: () => void;
  readonly project: Project;
  readonly remove: Removal;
  readonly targets: readonly Project[];
}) {
  const { api } = useDashboardClient();
  const { project } = props;
  const contents = useQuery({
    queryFn: () => api.getProjectContents(project.slug),
    queryKey: ["project-contents", project.slug],
  });
  return (
    <div className="grid gap-4">
      <h2 className="t-section" id="delete-project-title">
        Delete {project.name}
      </h2>
      {contents.isError ? (
        <ErrorNote error={contents.error} title="What the project holds could not be loaded." />
      ) : contents.data === undefined ? (
        <Skeleton label="Loading what the project holds" lines={3} />
      ) : (
        <Choices
          counts={contents.data}
          onCancel={props.onCancel}
          project={project}
          remove={props.remove}
          targets={props.targets}
        />
      )}
    </div>
  );
}

function Choices(props: {
  readonly counts: ProjectContentCounts;
  readonly onCancel: () => void;
  readonly project: Project;
  readonly remove: Removal;
  readonly targets: readonly Project[];
}) {
  const { counts, project, remove, targets } = props;
  const empty = counts.automations + counts.credentials + counts.runs === 0;
  const [kind, setKind] = useState<ProjectContentsChoice["kind"]>(
    targets.length > 0 ? "move" : "delete",
  );
  const [target, setTarget] = useState(targets[0]?.slug ?? "");
  const [typed, setTyped] = useState("");
  // Each choice holds its own field, so its radio takes its name from the title alone.
  const ids = useId();
  const choice: ProjectContentsChoice | null = empty
    ? null
    : kind === "move"
      ? { kind: "move", to: target }
      : { kind: "delete" };
  const ready =
    !remove.isPending &&
    (choice === null ||
      (choice.kind === "move" ? choice.to !== "" : typed.trim() === project.slug));
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) remove.mutate(choice);
      }}
    >
      <p className="t-meta" data-testid="project-contents">
        {empty
          ? "The project holds no automations, credentials or runs."
          : `The project holds ${count(counts.automations, "automation")}, ${count(counts.credentials, "credential")} and ${count(counts.runs, "run")}.`}{" "}
        Its access grants, service accounts and folders go with it; audit events stay.
      </p>
      {empty ? null : (
        <fieldset className="grid gap-3">
          <legend className="sr-only">What happens to its contents</legend>
          <label className="sheet-choice">
            <input
              aria-describedby={`${ids}-move-note`}
              aria-labelledby={`${ids}-move`}
              checked={kind === "move"}
              disabled={targets.length === 0}
              name="contents"
              onChange={() => setKind("move")}
              type="radio"
            />
            <span className="grid min-w-0 gap-2">
              <b id={`${ids}-move`}>Move them to another project</b>
              <span className="t-meta" id={`${ids}-move-note`}>
                The automations keep running there with their credentials and run history.
                {targets.length === 0 ? " You administer no other project." : ""}
              </span>
              {kind === "move" && targets.length > 0 ? (
                <select
                  aria-label="Target project"
                  className="field"
                  onChange={(event) => setTarget(event.target.value)}
                  value={target}
                >
                  {targets.map((option) => (
                    <option key={option.id} value={option.slug}>
                      {option.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          </label>
          <label className="sheet-choice">
            <input
              aria-describedby={`${ids}-delete-note`}
              aria-labelledby={`${ids}-delete`}
              checked={kind === "delete"}
              name="contents"
              onChange={() => setKind("delete")}
              type="radio"
            />
            <span className="grid min-w-0 gap-2">
              <b id={`${ids}-delete`}>Delete them with the project</b>
              <span className="t-meta" id={`${ids}-delete-note`}>
                Automations, credentials and runs are gone for good. This cannot be undone.
              </span>
              {kind === "delete" ? (
                <span className="form-label">
                  <span>
                    Type <span className="mono">{project.slug}</span> to confirm
                  </span>
                  <input
                    aria-label="Project short name"
                    autoComplete="off"
                    className="field mono"
                    onChange={(event) => setTyped(event.target.value)}
                    value={typed}
                  />
                </span>
              ) : null}
            </span>
          </label>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {remove.isError ? <ActionError error={remove.error} /> : null}
        <button
          className="btn quiet"
          disabled={remove.isPending}
          onClick={props.onCancel}
          type="button"
        >
          Cancel
        </button>
        <button className="btn danger" disabled={!ready} type="submit">
          {remove.isPending
            ? "Deleting…"
            : choice?.kind === "move"
              ? "Move and delete project"
              : "Delete project"}
        </button>
      </div>
    </form>
  );
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

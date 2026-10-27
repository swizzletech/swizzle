// Projects `/projects`: every project the signed-in person sees, with their role in it and the
// environments it protects. Owners and admins create projects here. Each row opens the project.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ActionError } from "../components/actions";
import { Chip, ErrorNote, Skeleton } from "../components/ui";
import { useDashboardClient } from "../lib/dashboard-client";
import { useMe, useProjects } from "../lib/queries";
import { ROLE_IN_WORDS } from "../lib/words/access";

export function ProjectsPage() {
  const projects = useProjects();
  const me = useMe();
  const operator = me?.role === "owner" || me?.role === "admin";
  return (
    <>
      <h1 className="t-page">Projects</h1>
      <p className="t-meta mt-1">
        A project holds automations and their credentials and decides who may see or change them.
        {operator
          ? " As an instance owner or admin you see every project; that access is audited."
          : " You see the projects a grant gives you."}
      </p>
      {operator ? <NewProject /> : null}
      <div className="mt-4">
        {projects.isError ? (
          <ErrorNote error={projects.error} title="The projects could not be loaded." />
        ) : projects.data === undefined ? (
          <div className="card">
            <Skeleton label="Loading projects" lines={3} />
          </div>
        ) : projects.data.length === 0 ? (
          <p className="card t-meta px-5 py-4">
            No project gives you a role yet. An owner or admin of this instance, or an admin of a
            project, can add you.
          </p>
        ) : (
          <div className="card rows overflow-hidden" data-testid="projects">
            {projects.data.map((project) => (
              <Link
                className="setting no-underline"
                key={project.id}
                params={{ project: project.slug }}
                to="/projects/$project"
              >
                <div className="min-w-0">
                  <b>{project.name}</b> <span className="mono t-faint">{project.slug}</span>
                  <div className="t-meta">
                    You are <b>{project.role}</b>: {ROLE_IN_WORDS[project.role].toLowerCase()}
                  </div>
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  {project.protectedEnvironments.map((environment) => (
                    <Chip key={environment} tone="warn">
                      {environment} protected
                    </Chip>
                  ))}
                  <span className="t-faint">›</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function NewProject() {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const suggested = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  const effectiveSlug = slug === "" ? suggested : slug;
  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), slug: effectiveSlug }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await navigate({ params: { project: project.slug }, to: "/projects/$project" });
    },
  });
  const ready = name.trim() !== "" && effectiveSlug !== "" && !create.isPending;
  return (
    <form
      className="card setting mt-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="form-label min-w-0 flex-1">
          Project name
          <input
            autoComplete="off"
            className="field"
            onChange={(event) => setName(event.target.value)}
            placeholder="Finance"
            value={name}
          />
        </label>
        <label className="form-label">
          Short name
          <input
            autoComplete="off"
            className="field mono"
            onChange={(event) => setSlug(event.target.value)}
            placeholder={suggested === "" ? "finance" : suggested}
            value={slug}
          />
        </label>
        {create.isError ? <ActionError error={create.error} /> : null}
        <span className="t-faint basis-full">
          A new project protects production and grants it to the team Release, which only caps the
          role a member holds in the project. Nobody but owners and admins has a role in it until
          you share it.
        </span>
      </div>
      <button className="btn" disabled={!ready} type="submit">
        {create.isPending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}

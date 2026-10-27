// One project `/projects/:slug`: who may do what in it (Access), its environments and their
// protection (Environments), its service accounts (Service accounts) and the credentials it shares
// and is offered (Credentials). A project select at the top switches between the projects the
// person sees; beside it, the project's admins delete it (project-delete.tsx). Only the project's
// admins, and instance owners and admins, manage it; anyone else sees their own role in each
// environment and shares the credentials they manage.
//
// The roles per environment come from the API's policy (`holders` of GET /projects/:slug/access);
// this page shows them and never derives what protection allows.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { ActionError } from "../components/actions";
import { HolderList } from "../components/holder-list";
import { accessChanged, ShareForm, subjectKey } from "../components/share-form";
import { Trail } from "../components/shell";
import { Chip, ErrorNote, Skeleton } from "../components/ui";
import { DEFAULT_PROJECT_ID, type Project, type ProjectAccess, type Subject } from "../lib/api";
import { useDashboardClient } from "../lib/dashboard-client";
import { useProjectAccess, useProjects } from "../lib/queries";
import { PROJECT_TABS, type ProjectTab } from "../lib/search";
import { ProjectCredentials } from "./project-credentials";
import { DeleteProject } from "./project-delete";
import { ServiceAccounts } from "./project-service-accounts";

const TAB_LABEL: Record<ProjectTab, string> = {
  access: "Access",
  environments: "Environments",
  "service-accounts": "Service accounts",
  credentials: "Credentials",
};

export function ProjectPage() {
  const { project: reference } = useParams({ from: "/projects/$project" });
  const projects = useProjects();
  if (projects.isError) {
    return <ErrorNote error={projects.error} title="The projects could not be loaded." />;
  }
  if (projects.data === undefined) {
    return (
      <div className="card">
        <Skeleton label="Loading the project" lines={4} />
      </div>
    );
  }
  const project = projects.data.find(
    (candidate) => candidate.slug === reference || candidate.id === reference,
  );
  if (project === undefined) {
    return (
      <>
        <Trail parent={{ label: "Projects", to: "/projects" }} />
        <div className="errbox" role="alert">
          <b>No project {reference} for you.</b>
          <p>
            Either it does not exist, or no grant gives you access to it. An admin of the project,
            or an owner or admin of this instance, can add you.
          </p>
        </div>
      </>
    );
  }
  return <LoadedProject project={project} projects={projects.data} />;
}

function LoadedProject(props: {
  readonly project: Project;
  readonly projects: readonly Project[];
}) {
  const { project } = props;
  const navigate = useNavigate({ from: "/projects/$project" });
  const tab = useSearch({ from: "/projects/$project" }).tab ?? "access";
  return (
    <>
      <Trail current={project.name} parent={{ label: "Projects", to: "/projects" }} />
      <div className="dhead">
        <div className="min-w-0">
          <h1 className="t-page">{project.name}</h1>
          <div className="t-meta mt-1">
            You are <b>{project.role}</b> here.{" "}
            {project.protectedEnvironments.length === 0
              ? "No environment is protected."
              : `Protected: ${project.protectedEnvironments.join(", ")}. A change there needs an environment grant; project admins keep admin.`}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {project.role === "admin" && project.id !== DEFAULT_PROJECT_ID ? (
            <DeleteProject project={project} projects={props.projects} />
          ) : null}
          <label className="form-label">
            Project
            <select
              className="field"
              onChange={(event) =>
                void navigate({
                  params: { project: event.target.value },
                  search: (previous) => previous,
                  to: "/projects/$project",
                })
              }
              value={project.slug}
            >
              {props.projects.map((option) => (
                <option key={option.id} value={option.slug}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {project.role === "admin" ? (
        <>
          <div aria-label="Project" className="dtabs mt-4" role="tablist">
            {PROJECT_TABS.map((key) => (
              <button
                aria-selected={tab === key}
                className="dtab"
                key={key}
                onClick={() => void navigate({ search: key === "access" ? {} : { tab: key } })}
                role="tab"
                type="button"
              >
                {TAB_LABEL[key]}
              </button>
            ))}
          </div>
          {/* Keyed, so an open form never carries one project's choices into another. */}
          <AdministeredProject key={project.id} project={project} tab={tab} />
        </>
      ) : (
        <>
          <OwnAccess key={project.id} project={project} />
          <ProjectCredentials key={`credentials:${project.id}`} project={project} />
        </>
      )}
    </>
  );
}

function AdministeredProject(props: { readonly project: Project; readonly tab: ProjectTab }) {
  if (props.tab === "credentials") return <ProjectCredentials project={props.project} />;
  return <ProjectAccessTabs project={props.project} tab={props.tab} />;
}

function ProjectAccessTabs(props: { readonly project: Project; readonly tab: ProjectTab }) {
  const access = useProjectAccess(props.project.slug);
  if (access.isError) {
    return <ErrorNote error={access.error} title="Who has access could not be loaded." />;
  }
  if (access.data === undefined) {
    return (
      <div className="card mt-4">
        <Skeleton label="Loading who has access" lines={4} />
      </div>
    );
  }
  if (props.tab === "environments") return <Environments access={access.data} />;
  if (props.tab === "service-accounts") return <ServiceAccounts access={access.data} />;
  return <Access access={access.data} />;
}

/**
 * A member's own view: their role in each environment, from the API, since only admins read the
 * project's grants.
 */
function OwnAccess({ project }: { readonly project: Project }) {
  const { api, authRevision, environments: listed } = useDashboardClient();
  const environments = [...new Set([...listed, ...project.protectedEnvironments])];
  const roles = useQuery({
    queryFn: () =>
      Promise.all(
        environments.map(async (environment) => ({
          environment,
          role: (await api.getIdentity(project.slug, environment)).target?.role ?? null,
        })),
      ),
    queryKey: ["own-access", project.slug, environments, authRevision],
  });
  return (
    <section className="mt-4">
      <div className="sec-head">
        <h2 className="t-section">Your access</h2>
        <p className="t-meta">
          Only the project's admins see who else has access and change it. Ask one of them for more.
        </p>
      </div>
      {roles.isError ? (
        <ErrorNote error={roles.error} title="Your access could not be loaded." />
      ) : roles.data === undefined ? (
        <div className="card">
          <Skeleton label="Loading your access" lines={2} />
        </div>
      ) : (
        <div className="card rows overflow-hidden" data-testid="own-access">
          {roles.data.map(({ environment, role }) => (
            <div className="setting" key={environment}>
              <span>
                <b>{environment}</b>
                {project.protectedEnvironments.includes(environment) ? (
                  <>
                    {" "}
                    <Chip tone="warn">Protected</Chip>
                  </>
                ) : null}
              </span>
              <span>
                {role === null ? "No access" : <span className="capitalize">{role}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const KIND_ORDER: Record<Subject["kind"], number> = { "service-account": 2, team: 1, user: 0 };

/** Who may do what: every holder with their role per environment and where it comes from. */
function Access({ access }: { readonly access: ProjectAccess }) {
  const [sharing, setSharing] = useState<{ readonly subject?: Subject } | null>(null);
  const holders = access.holders
    .filter((holder) => holder.subject.kind !== "service-account")
    .toSorted((left, right) => KIND_ORDER[left.subject.kind] - KIND_ORDER[right.subject.kind]);
  return (
    <section>
      <div className="sec-head">
        <h2 className="t-section">Who may do what</h2>
        <p className="t-meta">
          The highest role that applies counts. A protected environment gives only what an
          environment grant gives there.
        </p>
        <button className="btn ml-auto" onClick={() => setSharing({})} type="button">
          Share
        </button>
      </div>
      {sharing === null ? null : (
        <div className="mb-3.5">
          <ShareForm
            access={access}
            key={sharing.subject === undefined ? "new" : subjectKey(sharing.subject)}
            onDone={() => setSharing(null)}
            {...(sharing.subject === undefined ? {} : { subject: sharing.subject })}
          />
        </div>
      )}
      <HolderList
        access={access}
        holders={holders}
        onChange={(subject) => setSharing({ subject })}
      />
    </section>
  );
}

/**
 * Each environment with its protection switch, who may change it, and its environment grants.
 * Only a protected environment holds grants; unprotecting one removes them.
 */
function Environments({ access }: { readonly access: ProjectAccess }) {
  const { api } = useDashboardClient();
  const queryClient = useQueryClient();
  const [sharing, setSharing] = useState<string | null>(null);
  const protect = useMutation({
    mutationFn: (input: { readonly environment: string; readonly isProtected: boolean }) =>
      api.setProtected(access.project.slug, input.environment, input.isProtected),
    onSettled: () => accessChanged(queryClient),
  });
  return (
    <section>
      <div className="sec-head">
        <h2 className="t-section">Environments</h2>
        <p className="t-meta">
          In a protected environment a project role alone gives nothing: only an environment grant
          lets someone deploy, run or change it. Project admins keep admin.
        </p>
      </div>
      {protect.isError ? <ActionError error={protect.error} /> : null}
      <div className="grid gap-3.5">
        {access.environments.map((environment) => {
          const isProtected = access.protectedEnvironments.includes(environment);
          const changers = access.holders.filter((holder) => {
            const role = holder.environments[environment]?.role;
            return !holder.suspended && (role === "editor" || role === "admin");
          });
          return (
            <div className="card rows overflow-hidden" data-testid="environment" key={environment}>
              <div className="setting">
                <div className="min-w-0">
                  <b>{environment}</b>{" "}
                  {isProtected ? (
                    <Chip tone="warn">Protected</Chip>
                  ) : (
                    <Chip tone="idle">Open to the project's roles</Chip>
                  )}
                  <div className="t-meta mt-1">
                    May change it:{" "}
                    {changers.length === 0
                      ? "nobody"
                      : changers.map((holder) => holder.name).join(", ")}
                  </div>
                </div>
                <input
                  aria-label={`Protect ${environment}`}
                  checked={isProtected}
                  className="switch"
                  disabled={protect.isPending}
                  onChange={(event) => {
                    const grants = access.grants.filter(
                      (grant) => grant.on === "environment" && grant.environment === environment,
                    ).length;
                    if (
                      event.target.checked ||
                      grants === 0 ||
                      window.confirm(
                        `Unprotect ${environment}? This removes its ${grants} environment grant${grants === 1 ? "" : "s"}.`,
                      )
                    )
                      protect.mutate({ environment, isProtected: event.target.checked });
                  }}
                  type="checkbox"
                />
              </div>
              {isProtected ? (
                <div className="setting">
                  <HolderGrantsIn access={access} environment={environment} />
                  <button
                    className="btn quiet small"
                    onClick={() => setSharing(environment)}
                    type="button"
                  >
                    Grant access to {environment}
                  </button>
                </div>
              ) : (
                <div className="setting t-meta">Protect {environment} to grant access in it.</div>
              )}
              {isProtected && sharing === environment ? (
                <div className="p-3">
                  <ShareForm
                    access={access}
                    onDone={() => setSharing(null)}
                    place={{ environment, on: "environment" }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function HolderGrantsIn(props: { readonly access: ProjectAccess; readonly environment: string }) {
  const grants = props.access.grants.filter(
    (grant) => grant.on === "environment" && grant.environment === props.environment,
  );
  const nameOf = (subject: Subject) =>
    props.access.holders.find((holder) => subjectKey(holder.subject) === subjectKey(subject))
      ?.name ?? "someone no longer listed";
  return (
    <span className="t-meta">
      {grants.length === 0
        ? "No environment grant."
        : `Environment grants: ${grants.map((grant) => `${nameOf(grant.subject)} as ${grant.role}`).join(", ")}.`}
    </span>
  );
}

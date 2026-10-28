import { LOCAL_LLM_SERVICE } from "@swizzle/config/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ActionError } from "../../components/actions";
import { AuditHistory } from "../../components/audit-history";
import { useConfirm } from "../../components/confirm";
import { CopyButton, Dot, ErrorNote, Skeleton, useNow } from "../../components/ui";
import type { WorkerEnrollment, WorkerListing } from "../../lib/api";
import { useDashboardClient } from "../../lib/dashboard-client";
import { useProjects } from "../../lib/queries";
import { workerKindInWords, workerStateInWords, workerTone } from "../../lib/words/workers";
import { SECTION_DATA } from "./section";

export function Workers() {
  const confirm = useConfirm();
  const { api, environment, queryScope } = useDashboardClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [localLlm, setLocalLlm] = useState(false);
  const [profiles, setProfiles] = useState("");
  const [projectId, setProjectId] = useState("");
  const [enrollment, setEnrollment] = useState<WorkerEnrollment | null>(null);
  const pageHides = useRef(0);
  useEffect(() => {
    const forget = () => {
      pageHides.current += 1;
      flushSync(() => setEnrollment(null));
    };
    window.addEventListener("pagehide", forget);
    return () => window.removeEventListener("pagehide", forget);
  }, []);
  const now = useNow();
  const key = ["workers", ...queryScope];
  const workers = useQuery({
    meta: SECTION_DATA,
    queryKey: key,
    queryFn: () => api.listWorkers(),
    refetchInterval: 15_000,
  });
  const projects = useProjects();
  const create = useMutation({
    mutationFn: async () => {
      const before = pageHides.current;
      const result = await api.createWorker({
        name,
        profiles: profiles.trim() === "" ? [] : profiles.split(",").map((value) => value.trim()),
        environments: [{ projectId, environment }],
        services: localLlm ? [LOCAL_LLM_SERVICE] : [],
      });
      if (before === pageHides.current) setEnrollment(result);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeWorker(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  function workerList() {
    if (workers.isError)
      return <ErrorNote title="Workers could not be loaded." error={workers.error} />;
    if (workers.data === undefined) return <Skeleton label="Loading workers" lines={2} />;
    if (workers.data.workers.length === 0)
      return <p className="setting t-meta">No workers enrolled.</p>;
    return workers.data.workers.map((worker) => (
      <div className="setting" data-testid="worker" key={worker.id}>
        <div className="grid min-w-0 gap-1 wrap-anywhere">
          <p className="flex flex-wrap items-center gap-x-2">
            <Dot tone={workerTone(worker)} />
            <b>{worker.name}</b>
            <span className="t-meta">
              {workerKindInWords(worker.kind)} · {workerStateInWords(worker, now)}
            </span>
          </p>
          <RunImageDiskNotice worker={worker} />
          <p className="t-meta">Groups: {worker.profiles.join(", ") || "None"}</p>
          {/* A revoked worker holds no slot and runs nothing again. */}
          {worker.state === "revoked" ? null : (
            <p className="t-meta">
              {worker.currentRuns.length === 0 ? "Idle" : "Running "}
              {worker.currentRuns.map((run, index) => (
                <span key={run.runId}>
                  {index > 0 ? ", " : null}
                  {run.environment === environment ? (
                    <Link className="linkish" search={{ selected: run.runId }} to="/runs">
                      {run.automationName}
                    </Link>
                  ) : (
                    `${run.automationName} in ${run.environment}`
                  )}
                </span>
              ))}
              {` · ${worker.slotsInUse} of ${worker.capacity} ${worker.capacity === 1 ? "slot" : "slots"} in use`}
            </p>
          )}
          <p className="t-meta">
            Services:{" "}
            {worker.services.includes(LOCAL_LLM_SERVICE)
              ? `local-llm, ${worker.localLlm ?? "not reported"}`
              : "None"}
          </p>
          <p className="t-meta">
            Environments:{" "}
            {worker.environments === "all"
              ? "Every project and environment"
              : worker.environments
                  .map(
                    (grant) =>
                      `${projects.data?.find((project) => project.id === grant.projectId)?.name ?? grant.projectId} / ${grant.environment}`,
                  )
                  .join(", ") || "None"}
          </p>
          <WorkerHistory workerId={worker.id} />
        </div>
        {worker.state === "revoked" ? null : (
          <button
            aria-label={`Revoke worker ${worker.name}`}
            className="btn danger"
            type="button"
            disabled={revoke.isPending}
            onClick={async () => {
              const question = `Permanently revoke ${worker.name}?`;
              if (await confirm({ action: "Revoke", question })) revoke.mutate(worker.id);
            }}
          >
            Revoke
          </button>
        )}
      </div>
    ));
  }
  return (
    <section id="workers" className="scroll-mt-6">
      <div className="sec-head">
        <h2 className="t-section">Workers</h2>
        <p className="t-meta mt-1">
          Every machine that runs automations, its groups and what it runs now. To enroll another,
          approve groups and a project in {environment} below. New workers receive no default group.
          Each code admits one machine and expires in ten minutes.
        </p>
      </div>
      <div className="card rows overflow-hidden">
        {revoke.isError ? <ActionError error={revoke.error} /> : null}
        {workerList()}
        <form
          className="setting"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="form-label">
              Worker name
              <input
                className="field"
                value={name}
                maxLength={120}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="form-label">
              Groups (comma-separated)
              <input
                className="field"
                value={profiles}
                placeholder="gpu-home"
                onChange={(event) => setProfiles(event.target.value)}
              />
            </label>
            <label className="form-label">
              Project
              <select
                className="field"
                required
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                <option value="">Choose project</option>
                {projects.data?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-label">
              <input
                type="checkbox"
                checked={localLlm}
                onChange={(event) => setLocalLlm(event.target.checked)}
              />
              Allow local LLM inference
            </label>
            <button
              type="submit"
              className="btn"
              disabled={create.isPending || projectId === "" || name.trim() === ""}
            >
              Create enrollment code
            </button>
          </div>
        </form>
        {projects.isError ? (
          <ErrorNote title="Projects could not be loaded." error={projects.error} />
        ) : null}
        {create.isError ? <ActionError error={create.error} /> : null}
        {enrollment === null ? null : (
          <div className="setting">
            <div>
              <p>
                Copy this code once. It expires in ten minutes. Pipe it to{" "}
                <code>swizzle worker enroll --credential-file &lt;path&gt;</code> on the worker.
              </p>
              <code>{enrollment.code}</code>
              <CopyButton text={enrollment.code} label="Copy enrollment code" />
            </div>
            <button className="btn" type="button" onClick={() => setEnrollment(null)}>
              Dismiss code
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function WorkerHistory({ workerId }: { readonly workerId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>History</summary>
      {open ? <AuditHistory worker={workerId} /> : null}
    </details>
  );
}

function RunImageDiskNotice({ worker }: { readonly worker: WorkerListing }) {
  const warning = worker.runImageDiskWarning;
  return warning === null ? null : (
    <p className="notice" role="status">
      {warning.title} {warning.todo}
    </p>
  );
}

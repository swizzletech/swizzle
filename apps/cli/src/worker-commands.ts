/**
 * `swizzle worker groups | list | create | revoke | enroll`. A worker group is the
 * `runtime.profile` an automation names; it is not a CLI profile. Owners and admins create and
 * revoke workers; `enroll` runs on the worker machine with the single-use code `create` printed.
 */
import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { LOCAL_LLM_SERVICE } from "@swizzle/config";
import { DEFAULT_PROJECT_ID } from "@swizzle/db";
import type {
  WorkerResponse as RegisteredWorker,
  WorkerCredentialResponse as WorkerCredential,
  WorkerEnrollmentResponse as WorkerEnrollment,
  WorkerGroupsResponse,
  WorkersResponse,
} from "@swizzle/runtime/http-contract";
import type { Command } from "commander";
import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  addFieldsOption,
  buildApiUrl,
  DEFAULT_API_URL,
  type FieldsCommandOptions,
  localCommand,
  type RunHandler,
  requireYes,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, respond, selectFields, warn } from "./output.js";
import { loadProfileConfig, resolveProfile } from "./profile.js";

type WorkerSummary = WorkerGroupsResponse["groups"][number]["workers"][number];

const LIST_FIELDS = ["id", "name", "state", "groups"] as const;

/** The routes under /workers take no environment. */
function instanceUrl(pathname: string, options: ApiCommandOptions): string {
  const { environment: _environment, ...target } = options;
  return buildApiUrl(pathname, target);
}

export function registerWorkerCommands(program: Command, io: CliIO, runHandler: RunHandler): void {
  const group = program
    .command("worker")
    .description(
      "Worker groups and machines. A group is the `runtime.profile` an automation names, not a CLI profile",
    );
  showsSubcommands(group);
  withExamples(group, ["swizzle worker groups", "swizzle worker list"]);

  const groups = group
    .command("groups")
    .description(
      "List the worker groups that serve a project in this environment, for `runtime.profile` in config.yaml",
    )
    .option("--project <project>", "Project, by slug or id (default: the profile's, else Default)");
  withExamples(groups, [
    "swizzle worker groups",
    "swizzle worker groups --project billing -e prod --json",
  ]);
  groups.action(async (options: ApiCommandOptions & { project?: string }) =>
    runHandler(async () => {
      const environment = await resolveCommandEnvironment(options);
      const project = options.project ?? DEFAULT_PROJECT_ID;
      const data = await apiRequest<WorkerGroupsResponse>(
        buildApiUrl(`/projects/${encodeURIComponent(project)}/worker-groups`, {
          ...options,
          environment,
        }),
      );
      if (data.groups.length === 0) {
        respond(
          io,
          { groups: `0 worker groups serve ${options.project ?? "Default"} in ${environment}` },
          [
            "An instance owner or admin grants one with `swizzle worker create <name> --project <project-id> --groups <group>`",
          ],
        );
        return;
      }
      respond(io, {
        environment,
        count: data.groups.length,
        groups: data.groups.map((entry) => ({
          name: entry.name,
          workers: entry.workers.map(describeWorker).join("; "),
        })),
      });
    }),
  );

  const list = addFieldsOption(
    group
      .command("list")
      .description("List enrolled workers with their groups and state (owners, admins)"),
    LIST_FIELDS,
  );
  withExamples(list, ["swizzle worker list", "swizzle worker list --fields slots,runs --json"]);
  list.action(async (options: ApiCommandOptions & FieldsCommandOptions) =>
    runHandler(async () => {
      const { workers } = await apiRequest<WorkersResponse>(instanceUrl("/workers", options));
      if (workers.length === 0) {
        respond(io, { workers: "0 workers registered" }, [
          "Run `swizzle worker create <name> --project <project-id>` to enroll one",
        ]);
        return;
      }
      for (const { runImageDiskWarning: warning } of workers) {
        if (warning !== null) warn(`${warning.title} ${warning.todo}`);
      }
      const rows = workers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        state: worker.draining && worker.state === "online" ? "draining" : worker.state,
        groups: worker.profiles.join(" ") || "none",
        kind: worker.kind,
        slots: `${worker.slotsInUse}/${worker.capacity}`,
        runs:
          worker.currentRuns.map((run) => `${run.automationSlug}:${run.runId}`).join(" ") || "none",
        lastSeenAt: worker.lastSeenAt,
        services: worker.services.join(" ") || "none",
        localLlm: worker.localLlm,
        tokenExpiresAt: worker.tokenExpiresAt,
      }));
      respond(
        io,
        { count: rows.length, workers: selectFields(rows, LIST_FIELDS, options.fields) },
        ["Run `swizzle worker revoke <id> --yes` to retire one"],
      );
    }),
  );

  const create = group
    .command("create")
    .description(
      "Issue a single-use enrollment code for a new worker, valid ten minutes (owners, admins)",
    )
    .argument("<name>", "Worker name, such as gpu-box")
    .requiredOption("--project <id>", "Project UUID the worker may serve")
    .option("--local-llm", "Let automations on this worker request the local LLM service")
    .option("--groups <names>", "Comma-separated runtime groups (default: none)", "");
  withExamples(create, [
    "swizzle worker create gpu-box --project 6f1c… --groups gpu --local-llm -e prod",
    "swizzle worker create edge-1 --project 6f1c… --json",
  ]);
  create.action(
    async (
      name: string,
      input: ApiCommandOptions & { project: string; groups: string; localLlm?: boolean },
    ) =>
      runHandler(async () => {
        const environment = await resolveCommandEnvironment(input);
        const data = await apiRequest<WorkerEnrollment>(
          instanceUrl("/workers/enrollments", input),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              services: input.localLlm ? [LOCAL_LLM_SERVICE] : [],
              profiles: input.groups === "" ? [] : input.groups.split(","),
              environments: [{ projectId: input.project, environment }],
            }),
          },
        );
        respond(
          io,
          {
            worker: { id: data.worker.id, name: data.worker.name, environment },
            enrollmentCode: data.code,
            expiresAt: data.expiresAt,
          },
          [
            "On the worker machine, pipe the code to `swizzle worker enroll --credential-file <path>`; it works once",
          ],
        );
      }),
  );

  const revoke = group
    .command("revoke")
    .description("Permanently revoke a worker; a revoked one is a no-op (owners, admins)")
    .argument("<workerId>", "Worker id from `swizzle worker list`")
    .option("--yes", "Confirm the revoke (required)");
  withExamples(revoke, [
    "swizzle worker revoke 3b2a… --yes",
    "swizzle worker revoke 3b2a… --yes --json",
  ]);
  revoke.action(async (id: string, options: ApiCommandOptions & { readonly yes?: boolean }) =>
    runHandler(async () => {
      requireYes(
        options.yes,
        `swizzle worker revoke ${id}`,
        `worker ${id} loses its credential at once and stops taking runs; it needs a new enrollment to return.`,
      );
      const { workers } = await apiRequest<WorkersResponse>(instanceUrl("/workers", options));
      if (workers.find((worker) => worker.id === id)?.state === "revoked") {
        respond(io, { worker: id, state: "already revoked (no-op)" });
        return;
      }
      const data = await apiRequest<RegisteredWorker>(
        instanceUrl(`/workers/${encodeURIComponent(id)}`, options),
        { method: "DELETE" },
      );
      respond(io, { worker: data.id, name: data.name, state: "revoked" });
    }),
  );

  const enroll = localCommand(
    group
      .command("enroll")
      .description(
        "On the worker machine: read the single-use code from stdin and save the worker's credential",
      )
      .requiredOption(
        "--credential-file <path>",
        "New env file for the worker and its Compose stack, created with mode 0600; never overwritten",
      ),
  );
  withExamples(enroll, [
    'printf %s "$CODE" | swizzle worker enroll --credential-file ./worker.env --api-url https://swizzle.example.com',
    "swizzle worker enroll --credential-file ./worker.env --json < code.txt",
  ]);
  enroll.action(async (options: ApiCommandOptions & { credentialFile: string }) =>
    runHandler(async () => {
      const config = await loadProfileConfig();
      const hasProfile =
        options.profile !== undefined ||
        (process.env.SWIZZLE_PROFILE ?? "").trim().length > 0 ||
        config.defaultProfile !== undefined;
      const profile = hasProfile
        ? resolveProfile({
            config,
            ...(options.profile !== undefined ? { profile: options.profile } : {}),
          })
        : null;
      const apiUrl = options.apiUrl ?? profile?.url ?? DEFAULT_API_URL;
      const url = instanceUrl("/worker/enroll", { apiUrl });
      const target = new URL(url);
      if (
        target.protocol !== "https:" &&
        !(
          target.protocol === "http:" &&
          ["localhost", "api.localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
        )
      ) {
        throw new AgentError({
          code: "WORKER_TLS_REQUIRED",
          exitCode: EXIT_CODES.usage,
          hint: "Pass --api-url https://<instance>; plain http works only on loopback for a local test.",
          message: "Worker enrollment requires HTTPS.",
        });
      }
      const pipeHint =
        'Pipe the code `swizzle worker create` printed: printf %s "$CODE" | swizzle worker enroll --credential-file <path>';
      if (process.stdin.isTTY)
        throw new AgentError({
          code: "WORKER_CODE_REQUIRED",
          exitCode: EXIT_CODES.usage,
          hint: pipeHint,
          message: "No enrollment code on stdin.",
        });
      let code = "";
      for await (const chunk of process.stdin) {
        code += String(chunk);
        if (code.length > 256)
          throw new AgentError({
            code: "WORKER_CODE_INVALID",
            exitCode: EXIT_CODES.usage,
            hint: pipeHint,
            message: "Enrollment code is too long.",
          });
      }
      if (code.trim() === "")
        throw new AgentError({
          code: "WORKER_CODE_REQUIRED",
          exitCode: EXIT_CODES.usage,
          hint: pipeHint,
          message: "stdin held no enrollment code.",
        });
      const file = await open(options.credentialFile, "wx", 0o600);
      let saved = false;
      try {
        const data = await apiRequest<WorkerCredential>(url, {
          token: null,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        });
        // An env file: the worker reads it, and the worker-only Compose stack takes it as --env-file.
        await file.writeFile(
          [
            "# Swizzle worker credential. Keep this file private.",
            `SWIZZLE_WORKER_API_URL=${apiUrl}`,
            `SWIZZLE_WORKER_ID=${data.worker.id}`,
            `SWIZZLE_WORKER_TOKEN=${data.token}`,
            `SWIZZLE_LOCAL_LLM_CONTROL_TOKEN=${randomBytes(32).toString("base64url")}`,
            `SWIZZLE_WORKER_TOKEN_EXPIRES_AT=${data.worker.tokenExpiresAt}`,
            "",
          ].join("\n"),
        );
        saved = true;
        respond(io, {
          worker: { id: data.worker.id, name: data.worker.name, state: "enrolled" },
          credentialFile: options.credentialFile,
        });
      } finally {
        await file.close();
        if (!saved) await unlink(options.credentialFile);
      }
    }),
  );
}

/** `gpu-box online, local-llm healthy`: a machine's name, state and requested-service health. */
function describeWorker(worker: WorkerSummary): string {
  const state = worker.draining && worker.state === "online" ? "draining" : worker.state;
  const seen = worker.state === "offline" ? ` (last seen ${worker.lastSeenAt ?? "never"})` : "";
  const llm = worker.services.includes(LOCAL_LLM_SERVICE)
    ? `, local-llm ${worker.localLlm ?? "unreported"}`
    : "";
  return `${worker.name} ${state}${seen}${llm}`;
}

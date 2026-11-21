import { PassThrough } from "node:stream";
import type { ApprovalAssignee } from "@swizzle/db";
import { CodedError, isFinishedRun } from "@swizzle/db";
import { AutomationRuntimeError, buildDiagnosis } from "@swizzle/runtime";
import type {
  ApprovalAssigneeResponse,
  CancelRunResponse,
  ResumeRunResponse,
  RunDiagnosisResponse,
  RunLogStreamResponse,
  RunLogsResponse,
  RunResponse,
  TriggerRunResponse,
} from "@swizzle/runtime/http-contract";
import {
  type PlatformServices,
  type RunLogEvent,
  runResponse,
  subscribeRunLogEvents,
} from "@swizzle/runtime/platform";

import { type ApiServer, dashboardOrigin, requestValidationError } from "./http-shared.js";
import type { Actor } from "./request-access.js";
import { objectSchema, text } from "./request-validation.js";

const STREAM_RECHECK_MS = 15_000;

export function registerRunRoutes(app: ApiServer, platform: PlatformServices): void {
  const logsQuery = {
    schema: { querystring: objectSchema({ after: { pattern: "^\\d+:\\d+$", type: "string" } }) },
  };
  const approvalBody = {
    schema: {
      body: objectSchema(
        { approved: { type: "boolean" }, comment: { maxLength: 2_000, type: "string" } },
        ["approved"],
      ),
    },
  };
  const assigneeBody = {
    schema: {
      body: objectSchema({ reason: { maxLength: 500, type: "string" }, team: text, user: text }, [
        "reason",
      ]),
    },
  };
  app.get<{ Reply: RunResponse }>("/runs/:runId", async (request) => {
    const params = request.params as { runId: string };
    const run = await request.access.run(params.runId, "read");
    const origin = dashboardOrigin();
    return runResponse(run, origin === null ? null : `${origin}/runs?selected=${run.runId}`);
  });

  app.get<{ Reply: RunDiagnosisResponse }>("/runs/:runId/diagnosis", async (request) => {
    const params = request.params as { runId: string };
    const run = await request.access.run(params.runId, "read");
    const owner = await platform.findAutomation(run.automationSlug);
    if (owner?.automationId !== run.automationId || owner.projectId !== run.projectId) {
      return buildDiagnosis(run, undefined, undefined);
    }
    const [deployment, deployments] = await Promise.all([
      platform.getAutomationDeployment(run.automationSlug, run.environment).catch(() => null),
      platform.listAutomationDeployments(run.automationSlug, run.environment).catch(() => []),
    ]);
    return buildDiagnosis(run, deployment?.secretHealth, deployments);
  });

  app.post<{ Reply: TriggerRunResponse }>("/runs/:runId/replay", async (request) => {
    const { runId } = request.params as { runId: string };
    const source = await request.access.run(runId, "read");
    const automation = await request.access.automation(source.automationSlug, {
      action: "run",
      environment: source.environment,
    });
    if (automation.automationId !== source.automationId) {
      throw new AutomationRuntimeError(
        "AUTOMATION_NOT_FOUND",
        "The run's automation no longer exists.",
      );
    }
    await request.audit.note({ sourceRunId: runId });
    const run = await platform.startManualRun({
      automationName: source.automationSlug,
      environment: source.environment,
      correlationId: request.id,
      payload: source.payload,
    });
    return {
      deploymentId: run.deploymentId,
      queuedAt: run.queuedAt,
      runId: run.runId,
      status: run.status,
      ...(run.warning === undefined ? {} : { warning: run.warning }),
    };
  });

  app.post<{ Reply: CancelRunResponse }>("/runs/:runId/cancel", async (request) => {
    const params = request.params as { runId: string };
    await request.access.run(params.runId, "run");
    return await platform.cancelPlatformRun(params.runId);
  });

  app.post<{ Reply: ResumeRunResponse }>("/runs/:runId/events/:stepKey", async (request) => {
    const params = request.params as { runId: string; stepKey: string };
    const body = normalizeJsonObject(request.body);
    await request.access.run(params.runId, "run");
    const result = await platform.resolveRunEvent({
      runId: params.runId,
      stepKey: params.stepKey,
      value: Object.hasOwn(body, "value") ? body.value : null,
    });
    if (result.status === "resolved") {
      return { resumed: true, runId: result.run.runId, stepKey: params.stepKey };
    }
    throw new CodedError("RUN_EVENT_NOT_WAITING", "Run is not waiting for this event.");
  });

  app.post<{ Reply: ResumeRunResponse }>(
    "/runs/:runId/approvals/:stepKey",
    approvalBody,
    async (request) => {
      const params = request.params as { runId: string; stepKey: string };
      const body = request.body as { approved: boolean; comment?: string };
      const { approval, may } = await request.access.approval(params.runId, params.stepKey);
      const actor = request.actor;
      if (!may.decide || actor?.kind !== "person") throw approvalRefusal(actor, approval.assignee);
      const result = await platform.decideApproval({
        approved: body.approved,
        assignee: approval.assignee,
        comment: body.comment ?? null,
        decidedBy: { kind: "person", label: actor.label, userId: actor.userId },
        runId: params.runId,
        stepKey: params.stepKey,
      });
      if (result.status === "resolved") {
        return { resumed: true, runId: result.run.runId, stepKey: params.stepKey };
      }
      throw new CodedError(
        "RUN_EVENT_NOT_WAITING",
        "The approval was decided, timed out or reassigned meanwhile.",
      );
    },
  );

  app.put<{ Reply: ApprovalAssigneeResponse }>(
    "/runs/:runId/approvals/:stepKey/assignee",
    assigneeBody,
    async (request) => {
      const params = request.params as { runId: string; stepKey: string };
      const body = request.body as { user?: string; team?: string; reason: string };
      const { approval, may } = await request.access.approval(params.runId, params.stepKey);
      if (!may.reassign) {
        throw new AutomationRuntimeError(
          request.actor?.kind === "person" && request.actor.token === null
            ? "ACCESS_DENIED"
            : "APPROVAL_NEEDS_SIGN_IN",
          "Only an owner, an admin or an admin of the run's project reassigns an approval, signed in to the dashboard.",
        );
      }
      const reason = body.reason.trim();
      const wanted = body.user !== undefined ? { user: body.user } : { team: body.team ?? "" };
      if (reason === "" || (body.user === undefined) === (body.team === undefined)) {
        return requestValidationError(
          "Name either user (an email) or team (a name), and a reason.",
        );
      }
      const to = await platform.resolveApprovalAssignee(wanted);
      if (to === null) {
        throw new AutomationRuntimeError(
          "APPROVAL_ASSIGNEE_NOT_FOUND",
          "user" in wanted
            ? `No person with the email ${wanted.user} has an account here.`
            : `No team named ${wanted.team} exists here.`,
        );
      }
      await request.audit.note({ from: approval.assignee, reason, stepKey: params.stepKey, to });
      const moved = await platform.reassignApproval({
        from: approval.assignee,
        runId: params.runId,
        stepKey: params.stepKey,
        to,
      });
      if (!moved) {
        throw new CodedError(
          "RUN_EVENT_NOT_WAITING",
          "The approval was decided, timed out or reassigned meanwhile.",
        );
      }
      return { assignee: to, runId: params.runId, stepKey: params.stepKey };
    },
  );

  app.get<{ Reply: RunLogsResponse }>("/runs/:runId/logs", logsQuery, async (request) => {
    const params = request.params as { runId: string };
    const query = request.query as { after?: string } | undefined;
    const run = await request.access.run(params.runId, "read");
    const { stderrOffset, stdoutOffset } = parseLogCursor(query?.after);
    const stdout = run.stdout.slice(stdoutOffset);
    const stderr = run.stderr.slice(stderrOffset);
    const terminal = isFinishedRun(run.status);

    return {
      chunks: [
        ...(stdout.length > 0
          ? [
              {
                chunk: stdout,
                cursor: `${run.stdout.length}:${stderrOffset}`,
                stream: "stdout" as const,
              },
            ]
          : []),
        ...(stderr.length > 0
          ? [
              {
                chunk: stderr,
                cursor: `${run.stdout.length}:${run.stderr.length}`,
                stream: "stderr" as const,
              },
            ]
          : []),
      ],
      cursor: `${run.stdout.length}:${run.stderr.length}`,
      runId: run.runId,
      status: run.status,
      terminal,
    };
  });

  app.get<{ Reply: RunLogStreamResponse }>("/runs/:runId/logs/stream", async (request, reply) => {
    const params = request.params as { runId: string };
    const run = await request.access.run(params.runId, "read");
    const events = new PassThrough();

    const writeEvent = (eventName: string, payload: unknown) => {
      if (events.writableEnded) return;
      events.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    for (const execution of run.executions) {
      if (execution.stderr) {
        writeEvent("chunk", {
          chunk: execution.stderr,
          executionNumber: execution.executionNumber,
          stream: "stderr" as const,
          timestamp: execution.startedAt ?? execution.finishedAt ?? new Date().toISOString(),
        });
      }
    }

    writeEvent("status", { status: run.status, terminal: isFinishedRun(run.status) });

    reply
      .type("text/event-stream")
      .header("Cache-Control", "no-store, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no");

    if (isFinishedRun(run.status)) {
      writeEvent("end", { status: run.status });
      events.end();
      return reply.send(events);
    }

    const left = new AbortController();
    const open = () => !events.writableEnded && !events.destroyed;
    const keepAlive = setInterval(() => {
      if (!open()) return;
      request.access
        .fresh()
        .run(params.runId, "read")
        .then(
          () => open() && events.write(": keepalive\n\n"),
          () => open() && events.end(),
        );
    }, STREAM_RECHECK_MS);
    keepAlive.unref();
    events.once("close", () => {
      clearInterval(keepAlive);
      left.abort();
    });

    reply.send(events);
    try {
      await subscribeRunLogEvents({
        onError: (error: Error) => {
          app.log.warn({ err: error, runId: params.runId }, "SSE subscription error.");
        },
        onEvent: (event: RunLogEvent) => {
          if (event.type === "chunk") {
            writeEvent("chunk", {
              chunk: event.chunk,
              executionNumber: event.executionNumber,
              stream: event.stream,
              timestamp: event.timestamp,
            });
            return;
          }
          if (event.type === "step") {
            writeEvent("step", {
              attempt: event.attempt,
              executionNumber: event.executionNumber,
              key: event.key,
              status: event.status,
              timestamp: event.timestamp,
            });
            return;
          }
          writeEvent("status", { status: event.status, terminal: event.terminal });
          if (event.terminal) {
            writeEvent("end", { status: event.status });
            events.end();
          }
        },
        runId: params.runId,
        signal: left.signal,
        valkeyUrl: process.env.VALKEY_URL ?? "redis://localhost:6379",
      });
      const latest = await platform.getPlatformRun(params.runId);
      if (isFinishedRun(latest.status)) {
        writeEvent("status", { status: latest.status, terminal: true });
        writeEvent("end", { status: latest.status });
        events.end();
      }
    } catch (error) {
      if (!left.signal.aborted) {
        app.log.warn({ err: error, runId: params.runId }, "SSE subscription failed.");
        events.end();
      }
    }
    return reply;
  });
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return requestValidationError("Resolve event body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function approvalRefusal(
  actor: Actor | undefined,
  assignee: ApprovalAssignee | null,
): AutomationRuntimeError {
  if (actor?.kind !== "person" || actor.token !== null) {
    return new AutomationRuntimeError(
      "APPROVAL_NEEDS_SIGN_IN",
      "An approval is decided by a person signed in to the dashboard, never with a token.",
    );
  }
  if (assignee === null) {
    return new AutomationRuntimeError(
      "ACCESS_DENIED",
      "This approval is open to whoever may run the automation here, and you may not.",
    );
  }
  return new AutomationRuntimeError(
    "APPROVAL_NOT_ASSIGNED",
    assignee.kind === "user"
      ? `This approval is assigned to ${assignee.label}. An owner or admin can reassign it.`
      : `This approval is assigned to the team ${assignee.label}, and you are not a member. An owner or admin can reassign it.`,
    { details: { assignee } },
  );
}

function parseLogCursor(value: string | undefined): {
  readonly stderrOffset: number;
  readonly stdoutOffset: number;
} {
  const [stdoutOffset = 0, stderrOffset = 0] = (value ?? "0:0").split(":").map(Number);
  return { stderrOffset, stdoutOffset };
}

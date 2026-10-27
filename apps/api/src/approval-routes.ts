import type { ApprovalAssignee } from "@swizzle/db";
import type { HtmlResponse } from "@swizzle/runtime/http-contract";
import type { PlatformServices } from "@swizzle/runtime/platform";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  APPROVAL_PAGE_CSP,
  approvalPage,
  MAX_COMMENT_LENGTH,
  messagePage,
} from "./approval-page.js";
import {
  type ClientRateLimiter,
  clientKey,
  createClientRateLimiterFromEnvironment,
} from "./client-rate-limiter.js";
import type { ApiServer } from "./http-shared.js";

export function createApprovalRateLimiterFromEnvironment(): ClientRateLimiter {
  return createClientRateLimiterFromEnvironment("SWIZZLE_APPROVAL_RATE_LIMIT", "30/min");
}

export function registerApprovalRoutes(
  app: ApiServer,
  options: {
    readonly approvalRateLimiter: ClientRateLimiter;
    readonly platform: PlatformServices;
  },
): void {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );

  // GET only shows the page, so a mail scanner that opens the link decides nothing.
  app.get<{ Reply: HtmlResponse }>("/approvals/:token", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", APPROVAL_PAGE_CSP);
    reply.type("text/html; charset=utf-8");

    const limited = applyApprovalRateLimit(request, reply, options.approvalRateLimiter);
    if (limited !== null) return limited;

    const { token } = request.params as { token: string };
    const lookup = await options.platform.findWaitByLink({ kind: "approval", token });
    if (lookup.status === "closed") {
      reply.status(409);
      return renderClosedHtml();
    }
    if (lookup.status === "assigned") {
      reply.status(403);
      return renderAssignedHtml(lookup.assignee);
    }
    if (lookup.status !== "open") {
      reply.status(404);
      return renderNotFoundHtml();
    }
    return approvalPage({
      wait: lookup.wait,
    });
  });

  app.post<{ Reply: HtmlResponse }>("/approvals/:token", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", APPROVAL_PAGE_CSP);
    reply.type("text/html; charset=utf-8");

    const limited = applyApprovalRateLimit(request, reply, options.approvalRateLimiter);
    if (limited !== null) return limited;

    const { token } = request.params as { token: string };
    const body = normalizePostBody(request.body);
    const decision = body.decision;
    if (decision !== "approve" && decision !== "reject") {
      reply.status(404);
      return renderNotFoundHtml();
    }
    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    if (comment.length > MAX_COMMENT_LENGTH) {
      reply.status(400);
      return messagePage({
        heading: "Comment too long",
        message: `Shorten the comment to ${MAX_COMMENT_LENGTH} characters and decide again.`,
      });
    }

    const lookup = await options.platform.findWaitByLink({ kind: "approval", token });
    if (lookup.status !== "not-found") await request.audit.target(lookup.target);
    if (lookup.status === "closed") {
      reply.status(409);
      return renderClosedHtml();
    }
    if (lookup.status === "assigned") {
      reply.status(403);
      return renderAssignedHtml(lookup.assignee);
    }
    if (lookup.status !== "open") {
      reply.status(404);
      return renderNotFoundHtml();
    }

    const result = await options.platform.decideApproval({
      approved: decision === "approve",
      assignee: null,
      comment,
      decidedBy: { kind: "link" },
      runId: lookup.wait.runId,
      stepKey: lookup.wait.stepKey,
    });
    if (result.status !== "resolved") {
      reply.status(409);
      return renderClosedHtml();
    }
    return renderConfirmationHtml(decision === "approve");
  });
}

function applyApprovalRateLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  limiter: ClientRateLimiter,
): string | null {
  const decision = limiter.check(clientKey(request));
  if (decision.allowed) {
    return null;
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
  reply.header("Retry-After", String(retryAfterSeconds));
  reply.status(429);
  return messagePage({
    heading: "Too many requests",
    message: "Slow down and retry in a minute.",
  });
}

function normalizePostBody(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function renderConfirmationHtml(approved: boolean): string {
  return messagePage({
    heading: approved ? "Approved" : "Rejected",
    message: "The automation run has been resumed. You can close this tab.",
  });
}

/** An assigned approval is decided only signed in, so its assignee is who decided. */
function renderAssignedHtml(assignee: ApprovalAssignee): string {
  return messagePage({
    heading: "Decide in Swizzle",
    message: `This approval is assigned to ${assignee.kind === "team" ? "the team " : ""}${assignee.label}. Sign in to the Swizzle dashboard to decide it.`,
  });
}

function renderClosedHtml(): string {
  return messagePage({
    heading: "No longer open",
    message: "This approval was decided, timed out or expired. The link no longer works.",
  });
}

function renderNotFoundHtml(): string {
  return messagePage({
    heading: "Not found",
    message: "This approval link is not available.",
  });
}

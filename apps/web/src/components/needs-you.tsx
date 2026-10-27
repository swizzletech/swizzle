// The Overview's "Needs you": one row per thing the owner has to act on, each with its action
// inline or one click away. The API names each item's kind and facts; this module words them.

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { AttentionItem, AutomationRef } from "../lib/api";
import {
  apiChangeInWords,
  apiCheckHandoff,
  apiCheckInWords,
  apiCheckLevelInWords,
  apiCheckRunsInWords,
  apiSunsetHandoff,
  apiSunsetInWords,
  apiUntestedInWords,
  UPSTREAM_CONTRACT_CHANGED,
} from "../lib/words/api-checks";
import { CONNECTION_PROBLEM, namesInWords, SECRET_PROBLEM } from "../lib/words/credentials";
import type { Tone } from "../lib/words/health";
import {
  attentionKey,
  failingAutomationHandoff,
  platformProblemInWords,
} from "../lib/words/overview";
import { approvalDetailsInWords, assigneeInWords } from "../lib/words/runs";
import { ageInWords, deadlineInWords, durationInWords } from "../lib/words/time";
import { ApprovalActions, ConnectLink, SecretField } from "./actions";
import { Chip, CopyButton, useNow, WithCode } from "./ui";

export function NeedsYou(props: { readonly items: readonly AttentionItem[] }) {
  const now = useNow();
  return (
    <div className="card rows overflow-hidden" data-testid="needs-you">
      {props.items.map((item) => (
        <NeedRow item={item} key={attentionKey(item)} now={now} />
      ))}
    </div>
  );
}

function NeedRow({ item, now }: { readonly item: AttentionItem; readonly now: Date }) {
  switch (item.kind) {
    case "approval": {
      const details = approvalDetailsInWords(item.details);
      return (
        <Need
          act={<ApprovalActions runId={item.runId} stepKey={item.stepKey} />}
          kind={item.kind}
          label="Approval"
          meta={[
            details,
            item.assignee === null ? null : `assigned to ${assigneeInWords(item.assignee)}`,
            `waiting ${durationInWords(Math.max(0, now.getTime() - Date.parse(item.waitingSince)))}`,
          ]}
          tone="warn"
        >
          <AutomationName automation={item.automation} /> asks: <b>{item.stepKey}</b>
        </Need>
      );
    }
    case "failing":
      return (
        <Need
          act={
            <>
              <Link
                className="btn quiet"
                params={{ automationSlug: item.automation.automationSlug }}
                search={{ run: item.lastFailedRunId }}
                to="/automations/$automationSlug"
              >
                View
              </Link>
              <CopyButton label="Hand to agent" text={failingAutomationHandoff(item)} />
            </>
          }
          kind={item.kind}
          label="Failing"
          meta={[item.errorMessage, `last failed ${ageInWords(item.lastFailedAt, now)}`]}
          tone="fail"
        >
          <AutomationName automation={item.automation} />
          {item.errorCode === UPSTREAM_CONTRACT_CHANGED
            ? "'s API changed, so it is failing"
            : " is failing"}{" "}
          · {item.failedRuns} of {item.recentRuns} runs
        </Need>
      );
    case "missing-secret":
      return (
        <Need
          act={
            item.state === "missing" ? (
              <SecretField name={item.secretName} projectId={item.project.id} />
            ) : null
          }
          kind={item.kind}
          label="Blocked"
          meta={[SECRET_PROBLEM[item.state]]}
          tone="warn"
        >
          <b>{namesInWords(item.usedBy.map((ref) => ref.automationName))}</b> can't run: needs
          secret <span className="mono">{item.secretName}</span>
        </Need>
      );
    case "missing-connection":
      return (
        <Need
          act={
            item.status === "unbound" ? null : (
              <ConnectLink
                name={item.connectionName}
                projectId={item.project.id}
                provider={item.provider}
              />
            )
          }
          kind={item.kind}
          label="Blocked"
          meta={[CONNECTION_PROBLEM[item.status]]}
          tone="warn"
        >
          <b>{namesInWords(item.usedBy.map((ref) => ref.automationName))}</b> can't run: needs the
          account <span className="mono">{item.connectionName}</span>
        </Need>
      );
    case "waiting-for-worker":
      return (
        <Need
          act={
            <Link
              className="btn quiet"
              params={{ automationSlug: item.automation.automationSlug }}
              search={{ run: item.runId }}
              to="/automations/$automationSlug"
            >
              View
            </Link>
          }
          kind={item.kind}
          label="Waiting"
          meta={[item.reason, `fails at ${deadlineInWords(item.deadline, now)}`]}
          tone="warn"
        >
          <AutomationName automation={item.automation} />{" "}
          {item.queuedRuns === 1 ? "has a run" : `has ${item.queuedRuns} runs`} waiting for a worker
          in <b>{item.group}</b>
        </Need>
      );
    case "trigger-invalid":
      return (
        <Need
          act={<AboutLink automation={item.automation} label="View" />}
          kind={item.kind}
          label="Broken"
          meta={[item.message, "Ask your agent to fix the trigger in config.yaml and redeploy."]}
          tone="fail"
        >
          <AutomationName automation={item.automation} />
          's trigger does not work
        </Need>
      );
    case "api-check": {
      const runs = apiCheckRunsInWords(item);
      return (
        <Need
          act={
            <>
              <AboutLink automation={item.automation} label="View check" />
              <CopyButton label="Hand to agent" text={apiCheckHandoff(item)} />
            </>
          }
          kind={item.kind}
          label="API check"
          meta={[
            apiChangeInWords(item.change),
            item.check.failingSince === null
              ? null
              : `failing for ${durationInWords(Math.max(0, now.getTime() - Date.parse(item.check.failingSince)))}`,
            item.check.lastGreenAt === null
              ? "never green"
              : `last green ${ageInWords(item.check.lastGreenAt, now)}`,
          ]}
          tone="warn"
        >
          <AutomationLink automation={item.automation}>{apiCheckInWords(item)}</AutomationLink>
          {runs === null ? null : ` · ${runs}`}
        </Need>
      );
    }
    case "api-sunset":
      return (
        <Need
          act={
            <>
              {item.contact.noticeUrl === null ? null : (
                <a
                  className="btn quiet"
                  href={item.contact.noticeUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Read notice
                </a>
              )}
              <CopyButton label="Hand to agent" text={apiSunsetHandoff(item, now)} />
            </>
          }
          kind={item.kind}
          label="Sunset"
          meta={[
            item.contact.sunsetAt !== null && item.contact.deprecatedAt !== null
              ? `deprecated since ${item.contact.deprecatedAt.slice(0, 10)}`
              : null,
            item.contact.noticeRuns === 1 ? "seen once" : `seen ${item.contact.noticeRuns} times`,
            apiCheckLevelInWords(item.apiCheck),
          ]}
          tone="warn"
        >
          <AutomationName automation={item.automation} /> calls an API:{" "}
          {apiSunsetInWords(item.contact)}
        </Need>
      );
    case "api-untested":
      return (
        <Need
          act={<AboutLink automation={item.automation} label="View" />}
          kind={item.kind}
          label="Untested"
          meta={[
            `untested after ${durationInWords(item.thresholdMs)} without a call`,
            "its next real run tests it again",
          ]}
          tone="idle"
        >
          <AutomationName automation={item.automation} /> {apiUntestedInWords(item, now)}
        </Need>
      );
    case "platform": {
      const { title, todo } = platformProblemInWords(item.problem);
      return (
        <Need
          kind={item.kind}
          label="Platform"
          meta={[<WithCode key="todo" text={todo} />]}
          tone="idle"
        >
          <b>{title}</b>
        </Need>
      );
    }
    case "notifications-failed":
      return (
        <Need
          act={
            <Link className="btn quiet" hash="notifications" to="/settings">
              Open settings
            </Link>
          }
          kind={item.kind}
          label="Alerts"
          meta={[item.lastError, `last failed ${ageInWords(item.lastFailedAt, now)}`]}
          tone="warn"
        >
          <b>
            {item.failed === 1
              ? "1 notification could not be sent"
              : `${item.failed} notifications could not be sent`}
          </b>{" "}
          in the last 24 hours
        </Need>
      );
  }
}

function AboutLink(props: { readonly automation: AutomationRef; readonly label: string }) {
  return (
    <Link
      className="btn quiet"
      params={{ automationSlug: props.automation.automationSlug }}
      search={{ tab: "about" }}
      to="/automations/$automationSlug"
    >
      {props.label}
    </Link>
  );
}

function AutomationLink(props: {
  readonly automation: AutomationRef;
  readonly children: ReactNode;
}) {
  return (
    <Link
      className="font-bold no-underline hover:underline"
      params={{ automationSlug: props.automation.automationSlug }}
      to="/automations/$automationSlug"
    >
      {props.children}
    </Link>
  );
}

function AutomationName({ automation }: { readonly automation: AutomationRef }) {
  return <AutomationLink automation={automation}>{automation.automationName}</AutomationLink>;
}

function Need(props: {
  readonly act?: ReactNode;
  readonly children: ReactNode;
  readonly kind: AttentionItem["kind"];
  readonly label: string;
  readonly meta: readonly ReactNode[];
  readonly tone: Tone;
}) {
  const meta = props.meta.filter((part) => part !== null && part !== undefined && part !== "");
  return (
    <div className="need" data-kind={props.kind}>
      <span>
        <Chip tone={props.tone}>{props.label}</Chip>
      </span>
      <div className="what min-w-0">
        <div>{props.children}</div>
        {meta.length > 0 ? (
          <div className="t-meta">
            {meta.map((part, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
              <span key={index}>
                {index > 0 ? " · " : null}
                {part}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="act">{props.act}</div>
    </div>
  );
}

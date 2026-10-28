# Approval and event links

An approval gate pauses a run until a person approves or rejects it. An event wait pauses it until another system reports back. An approval can name the person or team who decides, and they decide signed in to the dashboard. An unassigned approval can also be decided by whoever holds its link. A third-party system resolves an event wait through its callback URL. Link holders and third-party systems may have no Swizzle credential, so each link must work without a login and allow only its one decision or event.

## An assignee decides signed in

`requestApproval(step, { assignee: { user: "anna@example.com" } })` assigns the approval to a person by email, and `{ team: "Finance" }` to a team by name. When the run starts to wait, the API resolves the name to the person's or team's id and keeps the email or team name as its label ([`handleSuspendedRunExecution`](../../packages/runtime/src/run-lifecycle/suspension.ts)). A name nobody holds fails the run with `APPROVAL_ASSIGNEE_NOT_FOUND`, because nobody could ever decide it.

`POST /runs/:runId/approvals/:stepKey` decides an approval, with `approved` and an optional `comment` ([`run-routes.ts`](../../apps/api/src/run-routes.ts)). [`approvalRights`](../../packages/db/src/access.ts) says who may:

- An assigned approval is decided by the assigned person, or by whoever is a member of the assigned team when they decide. They must still be able to read the run. Anyone else who sees the run gets `403 APPROVAL_NOT_ASSIGNED`, owners included.
- On the dashboard route, an unassigned approval is decided by anyone who may run the automation in the run's environment. A personal or service account token gets `403 APPROVAL_NEEDS_SIGN_IN`, so an agent never approves in its person's name. `GET /runs/:runId` returns the panel's address as `dashboardUrl` (null without `SWIZZLE_DASHBOARD_ORIGIN`), and `swizzle runs inspect` names it, so an agent can hand the person the page.
- The public link route can decide only an unassigned approval. It rejects an assigned approval with `403`.

An owner, an admin or an admin of the run's project reassigns an open approval to another person or team through `PUT /runs/:runId/approvals/:stepKey/assignee`. The request takes a reason of up to 500 characters. The dashboard's assignee picker uses the scoped people directory described in [the security model](security-model.md#people-invitations-roles-suspension-and-removal). The reason, the old and the new assignee go to the [audit](security-model.md#the-audit-records-every-change). The run panel shows **Approve** and **Reject** to whoever may decide, and **Reassign** to whoever may reassign. Needs you, on the Overview and in Runs, lists only the approvals the viewer may decide.

## One decision lands

A decision moves the run out of `waiting` and writes its step result in one transaction ([`resumeWaitingRun`](../../packages/db/src/control-plane-runs.ts)). The transaction commits only while the run still waits at that step and, for an approval, is still assigned to exactly the assignee the decider was checked against. Of two decisions at once, one commits. The other, and a decision after a reassignment, gets `409 RUN_EVENT_NOT_WAITING`, and the step result names the decision that landed.

## A link is a capability for one wait

A link names one run and one step, and is signed with a key that only that run and the platform know ([`wait-links.ts`](../../packages/runtime/src/wait-links.ts)):

```text
linkKey = HMAC-SHA256(SWIZZLE_ENCRYPTION_KEY, "swizzle-wait-link-v1")
runKey  = base64url(HMAC-SHA256(linkKey, "run:" + runId))
token   = runId "." base64url(stepKey) "." base64url(HMAC-SHA256(runKey, kind + "\n" + stepKey))
```

`kind` is `approval` for `/approvals/<token>` and `event` for `/events/<token>`, so an event callback is never an approval link for the same step.

The step key is unknown when an attempt starts, so the API cannot create the final links yet. It gives the run `runKey` as `SWIZZLE_LINK_KEY`, and the SDK signs each link when the automation asks for it. The run already holds a credential for its own waits, so the key grants it nothing new. The output redactor removes the key and every link token from stored run output and results. The API also redacts link tokens in responses to people and API tokens, including run logs, step values, automation state, child payloads, and approval details ([`server.ts`](../../apps/api/src/server.ts)). The approval page redacts links in its details separately, because its HTML response does not use the JSON response hook ([`approval-routes.ts`](../../apps/api/src/approval-routes.ts)). Worker routes return the stored values unchanged, so a resumed run can replay a link and a child run can read its original payload. The platform does not store links separately, which preserves the stateless wait-link design.

The platform stores no link. [`findWaitByLink`](../../packages/runtime/src/run-lifecycle/waits.ts) recomputes the signature, loads the run, and opens the link only when all of these hold:

- The run waits at exactly the step the link names.
- The wait is of the link's kind: an approval link needs an approval wait, an event link a plain event wait.
- An approval link needs an unassigned approval. An assigned one is decided signed in, so its link shows a page that names the assignee and decides nothing (`403`).
- The link has not expired. It expires at the wait's `until`. A wait without a timeout keeps waiting, but its link expires seven days after the wait began. Whoever may decide the approval can still do so in the dashboard.

Stateless links stay sound because a step waits at most once per run. A decision and a timeout both write the step result, and the platform never clears a step result while the run exists. A decided or timed-out step therefore never waits again, and its link stays closed. A link for a later step does nothing until the run reaches that step. A rotation of `SWIZZLE_ENCRYPTION_KEY` changes every key, so links sent before the rotation stop working.

## The run signs its own links

When the API has `SWIZZLE_LINK_URL` and a valid encryption key, it gives each deployed run `SWIZZLE_LINK_URL` and `SWIZZLE_LINK_KEY` ([`createRunLinkEnvironment`](../../packages/runtime/src/wait-links.ts), called from [`prepareRunExecution`](../../packages/runtime/src/run-lifecycle/execution.ts)). The SDK helpers build the links from those variables: [`getApprovalUrl`](../../packages/sdk-ts/src/index.ts) and [`getEventCallbackUrl`](../../packages/sdk-ts/src/index.ts), or [`get_approval_url` and `get_event_callback_url`](../../packages/sdk-py/swizzle_sdk.py). They fail when either variable is missing, which includes every local `swizzle run`.

The platform does not deliver the link. Automation code sends it, before it suspends, with whatever channel the decider reads or the third-party system accepts. Put that send inside a durable step, because the entrypoint runs again from the top when the run resumes, and an unwrapped send repeats on every resume.

## The public routes answer 404 for everything they will not do

`GET` and `POST /approvals/:token` in [`approval-routes.ts`](../../apps/api/src/approval-routes.ts) and `POST /events/:token` in [`event-callback-routes.ts`](../../apps/api/src/event-callback-routes.ts) are public: all three are `public` in [`ROUTE_ACCESS`](../../packages/runtime/src/http-contract.ts). A malformed or forged token gets the same 404 as an unknown one, so a guesser learns nothing about which runs exist.

`GET /approvals/:token` only shows the page: the automation, the step, when the link expires and the details. Mail scanners and link previews open links on their own, so opening one never decides. Only the **Approve** or **Reject** button posts the decision, with an optional comment of up to 2,000 characters. A valid approval link whose wait is over answers 409 and a "no longer open" page, so the person who clicks twice sees why nothing happened.

The public page ([`approval-page.ts`](../../apps/api/src/approval-page.ts)) and the dashboard's approval card in Needs you, the run panel, and the flow track use the same formatter, [`approvalDetailsInWords`](../../packages/config/src/approval-details.ts). A string or the first non-empty `message`, `question`, `summary`, or `title` field becomes the heading. Other fields keep their labels, and nested values appear as compact JSON. [Write an automation](../how-to/write-an-automation.md#wait-without-holding-a-worker) explains how to choose approval details.

The approval page follows the visitor's light or dark system setting. The public listener serves no dashboard assets, so the page carries its own design tokens. The page formats the deadline in the visitor's local time zone. Its form posts to the address that served the page. Approval links use the public listener. [The security model explains how Caddy preserves the API's script policy across all three routes](security-model.md#caddy-preserves-api-page-policies).

`POST /events/:token` takes the parsed body as the event value: JSON, form fields or text. A body over 64 KiB, the limit of one step result, gets 413. A forged, expired or already used callback gets the same 404 `EVENT_CALLBACK_NOT_AVAILABLE`, so the third-party system cannot probe with it.

Each route keeps a budget per client address: `SWIZZLE_APPROVAL_RATE_LIMIT` (default `30/min`) and `SWIZZLE_EVENT_CALLBACK_RATE_LIMIT` (default `60/min`). Caddy decides that address. By default it is the connecting address, and a client's own `X-Forwarded-For` counts for nothing. Behind a tunnel on the server every link holder then has the same address, so they share one budget. `SWIZZLE_LINK_TRUSTED_PROXY` names the tunnel, and the public listener then takes the client address the tunnel forwards ([give each tunnel client its own budget](../how-to/install.md#give-each-tunnel-client-its-own-rate-limit-budget)). Every answer sends `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, so the token does not leak into caches or into the `Referer` header of a link on the page. The request log writes both tokens as `[REDACTED]`.

## The step result records who decided

A decision resolves the wait through the same path as any external event ([resumed waits](durability.md#waiting-runs-give-the-worker-slot-back)): the decision is stored as the step result and the run is re-enqueued. The step result is the durable record of the decision, and the automation reads it when it resumes:

```json
{
  "approved": true,
  "assignee": { "kind": "team", "teamId": "…", "label": "Finance" },
  "decidedBy": { "kind": "person", "userId": "…", "label": "anna@example.com" },
  "comment": "Looks good",
  "decidedAt": "2026-10-24T10:12:00.000Z",
  "timedOut": false
}
```

`assignee` is whom the approval was assigned to when it was decided, or `null`. `decidedBy` is the signed-in person, or `{ "kind": "link" }` for a decision through the approval page. A timed-out wait has `approved: false`, `timedOut: true` and `decidedBy: null`. The run panel shows each decided approval step with its verdict, who decided, the assignee and the comment, from the steps the dashboard API returns ([`dashboard-routes.ts`](../../apps/api/src/dashboard-routes.ts)).

[`run-approval.ts`](../../packages/db/src/run-approval.ts) stores each step result with a `kind` field. Its `approval` value distinguishes platform decisions from ordinary JSON, even when an automation returns an object with the same fields. The dashboard reads the decision from that field, while the SDK gives the automation only the decision value.

## Keep the dashboard private

The packaged stack serves approval and event links on the public listener at `SWIZZLE_LINK_ORIGIN` ([Caddyfile](../../infra/docker/Caddyfile)). The listener also receives webhooks and OAuth callbacks, while every other path gets a bare 404. A private instance can expose the listener while keeping its dashboard, API and sign-in private. [The security model](security-model.md#the-public-listener-serves-only-public-routes) explains the route boundary. [Install a public listener](../how-to/install.md#receive-webhooks-and-share-links-on-a-private-instance) covers Tailscale Funnel, Cloudflare Tunnel and a separate Caddy hostname.


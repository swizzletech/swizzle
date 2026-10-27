# Failure notifications

Notification rules send Telegram alerts when an automation dead-letters a run. They also send one alert when an active API check starts failing or an API announces its retirement. Each rule belongs to the person who made it and reaches only what that person may read. Rules live outside `config.yaml`, so you can change them without a redeploy.

## Rules and deliveries are rows

A rule ([`notificationRules`](../../packages/db/src/schema.ts)) names its person, a project, an environment, a Telegram chat, one of two events and, optionally, an automation of that project. A rule without an automation covers every automation of its project in the environment, including ones deployed later. The dashboard's Settings switch "Message me on Telegram when a run finally fails" is such a rule for `dead-lettered` in the `default` project.

- `dead-lettered` fires for every run that ends dead-lettered.
- `repeated-failures` fires when the number of dead-lettered runs in a time window reaches a threshold.

Each rule also has a cooldown. Manage rules with `swizzle notify` or the dashboard ([`notification-routes.ts`](../../apps/api/src/notification-routes.ts)). Creating a rule needs read access to the automation or project it names, and a person: a session or a personal token. A service account has no person, so it makes no rules. Each person lists, changes and deletes only their own rules; another person's rule answers `404`. The bot token is the platform secret `SWIZZLE_TELEGRAM_BOT_TOKEN` ([`TELEGRAM_BOT_TOKEN_SECRET`](../../packages/runtime/src/notifications.ts)) of the environment, stored write-only like every other secret.

Every evaluation that matches writes a delivery row ([`notificationDeliveries`](../../packages/db/src/schema.ts)) with the status `pending`, then `sent`, `failed` or `skipped`. The outcome transaction commits the intent before delivery. A separate API loop locks only the delivery row, rechecks the person's current access and bounds the Telegram request to ten seconds. Pending intents survive a restart. `swizzle notify deliveries` and the dashboard's **Delivery history** list recent rows and show what was sent, what failed and why, for example a missing bot token or an active cooldown. Each person reads the deliveries of their own rules for automations they can still read; an instance owner or admin reads every delivery.

## Revoked access ends the messages

A rule's person can lose access after the rule was made. Before each delivery, [`deliverPendingNotification`](../../packages/runtime/src/notifications.ts) asks whether the person may still read the automation's runs in that environment ([`personMayRead`](../../packages/db/src/control-plane-people.ts)), using their current grants and team memberships. A revoked grant, leaving a team, or a suspension makes the delivery `skipped` with the reason `access-revoked`, and nothing reaches Telegram. This check runs before the cooldown check, so the delivery records revoked access even during a cooldown. The skipped row keeps the alert's dedupe key, so the same run alert is not sent later if access returns. Removing the person deletes their rules. Deleting a project deletes its rules, except a rule that names an automation the deletion moves to another project; that rule moves with it.

## A failed delivery never blocks a run

[`processRunNotifications`](../../packages/runtime/src/notifications.ts) runs after the run lifecycle has written the run's terminal status, and only records delivery intents; the API loop sends them later. The run is already dead-lettered in PostgreSQL when the platform contacts Telegram. A Telegram outage, a revoked bot or a wrong chat id becomes a delivery row with the status `failed` and the error message. It does not turn into a run error, a retry or a stuck worker.

The order matters because notifications exist for exactly the moments when something else is broken. A design that finalised the run only after a successful send would let a dead chat integration hold runs open.

## One delivery intent per rule and run

The delivery's dedupe key is `<event type>:<rule id>:<run id>`, with a unique index in PostgreSQL. Reprocessing a terminal run finds the existing intent and creates no second one. Delivery is at least once: a crash after Telegram accepts a message but before PostgreSQL records `sent` can send it again. The cooldown limits the noise across runs: a match inside the cooldown is recorded as `skipped` with the reason `cooldown`. The cooldown counts per rule, automation and event type, so one failing automation never mutes an alert about another under a rule for every automation, and an API alert never mutes a run alert.

The scheduler's maintenance cycle deletes old delivery rows ([`runMaintenanceCycle`](../../packages/runtime/src/maintenance.ts)). Rules stay until you delete them.

## API alerts fire once per change

[`sendApiAlert`](../../packages/runtime/src/notifications.ts) sends two more events to every enabled rule of the automation, whatever run event the rule names:

- `api-check` when an active API check enters Needs you. Drift triggers an alert at once. An undecided check triggers one after 3 consecutive failures. A green check ends the failure period, so a later failure can alert again.
- `api-sunset` when a run or a check first sees a Deprecation or Sunset notice for a host, or when the notice announces a new date. Another call with the same notice does not send another alert.

API alerts skip the cooldown. An automation with `api_check: off` can still get `api-sunset`, because SDK contact recording does not make an extra API call. API delivery rows use `api-check` or `api-sunset` as the event type and have no run id.

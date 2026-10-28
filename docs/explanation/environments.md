# Environments

One Swizzle instance serves staging and production. Staging is where you test an automation. Production is where it runs live. Each environment has its own deployments, secrets, state, and webhook URLs, so a staging test can use test credentials without changing production data. Outside services are separate only when you supply separate credentials or endpoints.

A fresh install defaults to production on every install path. The dashboard selects the API's default unless the browser has a saved environment choice. **Settings → Agent access** prints a CLI profile command for the selected environment. A CLI profile pins that environment with `--env`; `-e staging` or `-e production` overrides it for one command.

An existing install keeps its `SWIZZLE_ENVIRONMENT` setting and all its data in place. If it uses staging for live automations, those automations keep running there after an upgrade. Changing the default does not move deployments, secrets, state, runs, or schedules.

## Test in staging, then deploy to production

The environments already exist inside the instance. You do not need another stack or another scheduler. Deploy your source to staging and set its test secrets in that environment:

```bash
swizzle secret set SERVICE_TOKEN --value '<test-token>' -e staging
swizzle apply ./my-automation -e staging
swizzle trigger my-automation -e staging --payload '{"test":true}'
swizzle inspect my-automation -e staging
```

For a webhook automation, `apply`, `inspect`, and the dashboard's **About** tab show its staging webhook URL. Post a test payload to that exact URL, including `?environment=staging`. The production URL uses `?environment=production`, even when both deployments use the same path. A staging webhook starts only a staging run and resolves only staging secrets and state.

Once the tests pass, deploy the same source to production with its live secrets:

```bash
swizzle secret set SERVICE_TOKEN --value '<live-token>' -e production
swizzle apply ./my-automation -e production
swizzle inspect my-automation -e production
```

Supply `--project <slug>` on these commands when the automation belongs to another project. Deploying source to production creates its production deployment. It does not copy staging secrets, state, or run history. For a webhook, configure the sender with the production URL that `inspect` returns.

A cron deployed to both environments runs in both. Both runs can reach outside services, so pause the staging schedule when you want only production to run:

```bash
swizzle trigger pause my-automation -e staging
```

## One scheduler serves every environment

The scheduler discovers environments from the instance on every pass. It starts cron runs and checks due APIs in each environment, including environments added after it starts. A busy environment skips its own next poll while its previous pass finishes. Other environments continue polling, even while that environment drains a cron backlog. `SWIZZLE_ENVIRONMENT` selects the API default. It does not limit scheduler coverage. Workers execute runs only in environments their grants allow.

Runtime operations require an explicit environment, so a missing argument cannot select a different namespace. A local `swizzle run` names `local` explicitly.

Projects can protect production independently. Protection limits who can change a project's production deployment, but does not create another runtime namespace. Automation folders group automations within a project and do not change runtime data. See [the security model](security-model.md) for project and environment grants.

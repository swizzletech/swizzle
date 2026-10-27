# Give people access to projects and production

An office shares one instance. Members see only the projects they are given. Owners and admins see every project. This guide sets up project and production access in the dashboard. [The security model](../explanation/security-model.md#one-policy-decides-access) explains how the roles combine.

Use an owner or instance admin account to manage access across the instance. Use a project admin account to delete that project.

The steps use a small office as the example: a project `buero` for everyday work, a confidential project `finanzen`, a team `Büro` that builds automations, and the team `Release` that may change production.

## Create a project for each body of work

1. Open **Projects**.
2. Enter a **Project name** and a **Short name**. The short name is the slug that `swizzle apply --project` and `?project=` take.
3. Select **Create project**.

A new project protects `production`. Until you share the project, only owners and admins see it. Put confidential work in its own project rather than relying on a folder. A folder sorts automations but grants no access.

## Delete a project

1. Open the project and select **Delete project**.
2. If the project has no automations, credentials, or runs, confirm the deletion.
3. If it has automations, credentials, or runs, choose whether to move them to another project you administer or delete them with the project.
4. To delete the contents, type the project's short name to confirm.

Before deletion starts, click outside the dialog or press Escape to close it.

The CLI asks for the same choice. Without `--move-to` or `--delete-contents`, a project that holds something answers `PROJECT_NOT_EMPTY` with its counts:

```bash
swizzle projects delete old-experiments --move-to buero --yes
swizzle projects delete old-experiments --delete-contents --yes
```

Moving keeps the automations, credentials, and runs, but removes their folders and credential shares that no longer apply. A credential name already used in the target project and environment blocks the move. Deleting removes the automations and their runs, deletes secrets, and revokes connections at their providers. The delete choice fails while any run is queued, running, or waiting. Either choice removes the project's access grants and service accounts. Audit events stay after either choice. [The security model](../explanation/security-model.md#one-policy-decides-access) explains which history stays with a project.

## Invite the people

1. Open **Settings → People** and invite the person as a `member`. Follow [the invitation steps in the install guide](install.md#invite-people) to copy the link or send it by mail.

A member without a grant sees no project. You can tick projects in the invitation, or give access afterwards through a team. Give the `admin` or `owner` role only to people who run the instance, because both see every project. Keep a second owner, since the last owner cannot be removed or demoted.

## Give a team a role in a project

1. Open **Settings → Teams**, enter a **Team name**, and select **Create team**.
2. Pick each member in **Add someone to <team>**.
3. Open the project, then the **Access** tab, and select **Share**.
4. In **Who**, choose the team. In **Where**, keep **The whole project**. In **Role**, choose `Editor` for people who write and deploy automations, `Operator` for people who start them, or `Viewer` for people who only read.
5. Select **Share**.

The **Access** tab lists each holder's effective role in every environment and the grants that provide it. A team grant in a protected environment caps members at `editor` but does not grant project access. Removing one grant leaves other grants in place, so review the list after each removal. Run `swizzle projects access <project>` to see the same holders and effective roles from the CLI. There a team's grant in a protected environment reads as the role it caps members at, such as `production=editor (grant)`.

The dashboard hides controls your role cannot use and explains which role or grant each action needs. On a failed run, **Hand to agent** appears only if you may edit the automation, since the agent changes and deploys it. The Overview shows failing runs, missing deployment requirements, broken triggers, and API warnings only for automations you may edit. It shows runs waiting for a worker and platform problems only to instance owners and admins, who can grant and run workers. Assigned readers still see approvals they may decide. On an empty instance, the Overview shows agent setup steps only if you may deploy to the default project. Otherwise, it names the role or grant you need.

## Add people who may release

Initial setup creates the team `Release` and adds the first owner to it. Each project, including the `Default` project, grants `Release` the `Editor` role in `production` while the team exists. This grant does not give access to project content. An invited person joins no team until an admin adds them.

1. Open **Settings → Teams** and add the people who may release to the team `Release`.
2. Give them a role in the project as well, such as `Editor` through the team `Büro`. A person needs both a project role and a production grant to change production. The production grant caps the role their project access permits there.

A project editor outside `Release` and without another production grant cannot deploy, roll back, pause, or start anything in production, and cannot see its runs. `swizzle apply -e production` answers `ACCESS_DENIED` and names the protected environment. Ask the project's admin for a production grant, or ask an owner or admin to add you to a team that holds one. Project admins keep admin access in production.

To lift protection through the CLI, run `swizzle projects unprotect <project> <environment> --yes`. The command reports whether protection changed and how many environment grants it removed. If the environment is already unprotected, the command reports a no-op. Project grants reach the environment again after you confirm.

To remove `Release`'s production grant from one project, open the project's **Access** tab and select **Remove** next to `editor in production` on the `Release` row. Production stays protected. Other grants still apply.

To let a different team release in a project, select **Grant access to production** on its **Environments** tab, choose that team, and choose `Editor`. Deleting the team `Release` removes its grants. Production stays protected, and new projects receive no automatic production grant.

## Let one person run one automation

To let someone run a finished automation without seeing the rest of the project:

1. On the project's **Access** tab, select **Share**.
2. Choose the person, select **One automation**, pick the automation, and choose `Operator`.
3. If the automation runs in a protected environment, share again with **One protected environment**, that environment, and `Operator`.

The person can start that automation and read its runs, logs, and results. Other automations of the project answer as if they did not exist. An operator deploys nothing, so they cannot change the code or put the project's credentials into code of their own.

## Decide who may use a credential

A secret belongs to one project and one environment. On **Credentials**, choose the project in **Project**, then add the secret. The CLI takes the project as a flag:

```bash
swizzle secret set MAIL_KEY --project buero -e staging --value-env MAIL_KEY
```

An editor who deploys a version that declares a secret needs the `use` right on it. Its creator, the project's admins, and owners and admins hold `manage`, which includes `use`. To give someone `use`:

1. On **Credentials**, select **Access** on the secret's row.
2. Under **Grant a right**, choose the person, team, or service account in **Who**, choose `use`, and select **Grant**.

To take it back, select **Remove the grant of <name>** in the same dialog. The CLI does both:

```bash
swizzle credential grant secret MAIL_KEY --project buero -e staging --user anna@example.com --right use
swizzle credential revoke secret MAIL_KEY --project buero -e staging --user anna@example.com
```

Give `use` only to people whose code you trust with the value. [Credentials need use and manage rights](../explanation/security-model.md#credentials-need-use-and-manage-rights) explains what revoking stops and what keeps running.

## Connect an external CI with a service account

A service account belongs to the project, so the CI keeps working when the person who set it up leaves.

1. As an admin of the project, open its **Service accounts** tab, enter a **Name** such as `ci`, and select **Create service account**.
2. Select **Change rights**. Share the whole project with the account as `Editor`, then share **One protected environment**, `production`, as `Editor`.
3. Under the account's tokens, enter a **Token name**, choose **Expires after**, tick `production` under **Only in**, and select **Create token**.
4. Copy the token into the CI's secret store. The dashboard shows it once.

In the CI, point the CLI at the instance with that token and pin the project and environment:

```bash
swizzle profile add ci --url https://api.swizzle.example.com --token-env SWIZZLE_CI_TOKEN --env production --project buero --default
swizzle whoami
swizzle apply ./automations/report
```

`swizzle whoami` names the service account, its project, and its role. The account's card lists each token's scope and last use. **What it did** lists the account's changes with the token that made them. To replace a token, select **Rotate**: the new value shows once and the old one stops at once. **Revoke** stops a token on its next request.

## Give every person their own CLI profile

A personal token acts with its person's current rights and loses them on the next request after a grant is removed. A service account token acts as the account and never beyond its grants. The CLI stores its profiles in `~/.swizzle/config.toml` of the operating-system account that runs it. On a shared machine, give each person their own operating-system account, so nobody's commands run with someone else's token. Each person mints their token in **Settings → Agent access** and checks it with `swizzle whoami`.

## When someone leaves

1. Open **Settings → People** and select **Suspend** on the person. Their browser sessions end at once and their tokens are refused on the next request.
2. When nothing of theirs needs a look anymore, select **Remove**.

| Stops | Keeps working |
|---|---|
| Their sign-in, sessions, and personal tokens | Automations they deployed, with their triggers and schedules |
| Their grants, team memberships, and pending invitations | Service accounts they created, with their tokens, each still naming them as its creator or issuer |
| Decisions on approvals assigned to them: those wait until an owner, an admin, or the project's admin reassigns them | Their audit events, with the address they had |

Review what they could reach before you remove them. A credential value they could inject in their own code may need a new value.

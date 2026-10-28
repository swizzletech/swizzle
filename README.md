<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo.svg" alt="Swizzle" width="360">
  </picture>
</h1>

Swizzle is a self-hosted runtime for automations written as ordinary code.

[![CI](https://github.com/swizzletech/swizzle/actions/workflows/ci.yml/badge.svg)](https://github.com/swizzletech/swizzle/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@swizzletech/cli)](https://www.npmjs.com/package/@swizzletech/cli)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Website](https://swizzletech.github.io/swizzle-site/) · [Documentation](docs/README.md) · [Changelog](CHANGELOG.md)

</div>

Write the business logic in Python, JavaScript, or TypeScript. Swizzle handles queues, retries, secrets, versioned deployments, and logs.
It ships as a Docker Compose stack with a dashboard and the `swizzle` CLI.

Use it for scheduled jobs, incoming webhooks, and workflows that need to pause for approval or an external event.
Keep the code in your editor and use the dashboard to inspect runs, manage access, and retry failures.

![Dark-mode Play view of document-scanner with its Python code, step diagram, and a successful run that includes an approval step](docs/assets/dashboard.png)

## Quick start

You need Docker Engine with Compose v2, Git, and [mise](https://mise.jdx.dev).
Run these commands on the host where you want Swizzle to run:

```bash
git clone https://github.com/swizzletech/swizzle.git
cd swizzle
mise trust && mise install
just stack
```

`just stack` writes `.env` with fresh credentials on its first run, then builds the images in Docker and starts the stack.
Open `http://localhost:19826` on that host. Claim the instance with `SWIZZLE_SETUP_TOKEN` from `.env`.
[Install Swizzle on a server](docs/how-to/install.md) covers remote access, HTTPS, mail, webhook URL routing, and hardening.
[Upgrade an installed server](docs/how-to/upgrade.md) covers server and CLI updates and recovery.

## Try an automation

Install the CLI from npm on any machine with Node.js 22.18 or later, then create and run a Python automation:

```bash
npm install --global @swizzletech/cli
swizzle init hello --template python
swizzle run hello
```

This short demo runs trusted code on your host and needs no instance. To deploy it to Swizzle's restricted Docker sandbox, [connect the CLI](docs/how-to/install.md#connect-the-cli) to your instance first. Then store the webhook's signing secret, validate the automation against the instance, and deploy it:

```bash
export HELLO_SIGNING_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('hex'))")"
swizzle secret set HELLO_SIGNING_SECRET --value-env HELLO_SIGNING_SECRET
swizzle validate hello
swizzle apply hello
```

[Build your first automation](docs/tutorials/first-automation.md) walks through the result and deployment.

## Explore

- [Documentation](docs/README.md): tutorials, how-to guides, reference, and explanations.
- [Runnable examples](infra/examples/README.md): complete automations to start from.
- [Runtime contract](docs/reference/runtime-contract.md): inputs, JSON output, logs, and SDK helpers.
- [Security model](docs/explanation/security-model.md): isolation, authentication, and permissions.
- [Changelog](CHANGELOG.md): changes in each release.
- [Contributing](CONTRIBUTING.md): build, test, and propose a change.
- [Security policy](SECURITY.md): report vulnerabilities privately.
- [Code of conduct](CODE_OF_CONDUCT.md): community expectations.

## Status and support

Swizzle is provided as is, without warranty of any kind. The [Apache License 2.0](LICENSE) sets out the terms in section 7, Disclaimer of Warranty, and section 8, Limitation of Liability.
It is maintained on a best-effort basis. The maintainers have no obligation to maintain, support, fix, or update it, and there are no guaranteed response times for issues, pull requests, or security reports.

## License

Swizzle is licensed under the [Apache License 2.0](LICENSE).

# Contributing to Swizzle

Start with an issue for a feature or a change to a public contract. For a bug, include the steps to reproduce it and the expected result.
Report vulnerabilities through the [security policy](SECURITY.md), and follow the [code of conduct](CODE_OF_CONDUCT.md).

The maintainers work on Swizzle on a best-effort basis. Issues and pull requests may not be reviewed or answered, and a pull request may be closed without merge.

## Set up a checkout

You need Git, Docker Engine with Compose v2, and [mise](https://mise.jdx.dev).

```bash
git clone https://github.com/swizzletech/swizzle.git
cd swizzle
mise trust && mise install
just setup
git switch -c fix/describe-the-change
```

`just setup` installs the pinned dependencies, Git hooks, and browser. It generates a local `.env` with fresh credentials through `just init-env`, which is all a server install runs.
Keep that file and all tokens out of commits, issues, and logs.

To run the CLI from your checkout instead of the npm package, build it and alias it:

```bash
just build
alias swizzle="node $PWD/apps/cli/dist/bin.js"
```

## Build and test

Run repository commands through `just`. Run `just` to list the recipes.

```bash
just dev
```

The development stack prints its dashboard URL and test login. It owns its ports and data, so separate checkouts can run together.
[Run a local stack](docs/how-to/run-a-local-stack.md) covers lifecycle and cleanup.

While you work, run focused tests and the static gate:

```bash
just test path/to/changed.test.ts
just check
```

Before opening a pull request, run the full verification and secret scan:

```bash
just verify
just secret-scan
```

`just verify` builds the packages, checks documentation and migrations, tests against a disposable PostgreSQL database, and exercises the dashboard.
Tests must own their files, processes, ports, and data. Update the documentation page that owns any behavior you change; [the documentation index](docs/README.md) names each owner.

## Propose a change

Keep a pull request focused on one problem. Explain the resulting behavior, how you tested it, and any limits reviewers need to know.
Use a Conventional Commits title, such as `fix(cli): explain a refused deployment` or `feat(runtime): add a trigger`.
CI accepts the types `feat`, `fix`, `perf`, `test`, `docs`, `refactor`, `build`, `ci`, and `chore`; the scope is optional.

The maintainers squash pull requests, so the title becomes the commit subject.
Pull requests must pass verification, dependency review, and security checks before merge.

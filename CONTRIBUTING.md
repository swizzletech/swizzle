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

Keep explanations in names, types, tests, or commit messages. Put a hazard comment marked `HAZARD:` on the line it guards or directly above it.
When you remove comments that count toward the [comment budget](scripts/conventions/comment-budget.json), lower the file's count or remove its entry at zero.
`just check` checks tracked TypeScript, CSS, and HTML source files and refuses budget increases. Locally and on pull requests, it compares the budget with the merge base with `main`. On a CI push to `main`, it compares with the previous branch tip.
CI requires a committed baseline.
Outside CI, if the checkout lacks a baseline, the check reports that it skipped the budget growth comparison.

Before opening a pull request, run `just verify`.

```bash
just verify
```

`just verify` checks documentation, migrations, Compose files, and tracked files for secrets. It tests against a disposable PostgreSQL database, builds the packages, and exercises the dashboard.
CI runs the same verification lanes in parallel. `just check` checks that the required CI jobs cover every lane in `just verify`.
Use the built-in `bash` shell for required CI steps, or enable errexit in a custom Bash shell template.
Errexit keeps a later successful command from hiding a failed verification command.
Tests must own their files, processes, ports, and data. Update the documentation page that owns any behavior you change; [the documentation index](docs/README.md) names each owner.

Edit [the logo source](docs/assets/logo-dark.svg) when the brand artwork changes. Run `just gen` to regenerate the dashboard, approval page, and light README variants.

## Refresh dependencies

Run `just deps-update` to update workspace dependencies within their version ranges. The same command refreshes the exact Claude Code and Codex pins within their current major versions in the [runner Dockerfile](infra/docker/Dockerfile). A `0.x` pin can move to a newer `0.x` minor.
Run `just deps-outdated` to list newer releases for workspace dependencies and the runner CLIs, including major upgrades. It exits with status 1 when it finds an outdated dependency.

## Propose a change

Keep a pull request focused on one problem. Explain the resulting behavior, how you tested it, and any limits reviewers need to know.
Use a Conventional Commits title, such as `fix(cli): explain a refused deployment` or `feat(runtime): add a trigger`.
CI accepts the types `feat`, `fix`, `perf`, `test`, `docs`, `refactor`, `build`, `ci`, and `chore`; the scope is optional.

If your commit uses `Public-Title:` or `Public-Change:` trailers, place them in the final trailer block.
Keep other trailers such as `Co-Authored-By:` in the same block without blank lines between them. The commit hook rejects public trailer lines outside that block.

The maintainers squash pull requests, so the title becomes the commit subject.
Pull requests must pass verification, dependency review, and security checks before merge.
An automated review comments on every pull request against the rules that [`.coderabbit.yaml`](.coderabbit.yaml) points at. The static gate reports malformed path settings and paths that match no tracked file. Resolve each of its threads with a fix or a reply, as you would a maintainer's.

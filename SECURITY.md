# Security policy

## Supported versions

Security fixes, when the maintainers make them, ship in the latest Swizzle 1.0.x patch release. Use the latest patch release in that series.
Pre-releases are for evaluation and receive fixes in the next pre-release or stable version.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/swizzletech/swizzle/security/advisories/new).
Include the affected version, the deployment configuration, steps to reproduce the issue, and its impact.
Remove real credentials and personal data from examples.

Keep exploit details out of public issues, discussions, and pull requests until the maintainers coordinate disclosure with you.
The maintainers handle reports on a best-effort basis, with no commitment to a response time or a fix. When they confirm a vulnerability, they work with you on a fix and publish a security advisory when the fix is available.

Read [the security model](docs/explanation/security-model.md) for the platform's isolation and trust boundaries.
Local `swizzle run` executes trusted code on the host. Deployed runs use the restricted Docker sandbox.

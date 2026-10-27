# Grant one automation a longer run timeout

`runtime.timeout` may not exceed the platform ceiling `SWIZZLE_MAX_RUN_TIMEOUT`, which defaults to `1h`. A deploy above it fails, and the worker checks again before each run, so an old deployment cannot hold a slot longer. When one automation needs more, such as a 3-hour batch job, grant that automation a higher ceiling instead of raising the ceiling for every automation.

A grant belongs to one automation in one environment and is stored in PostgreSQL, not in `config.yaml`. The effective ceiling is the larger of the grant and `SWIZZLE_MAX_RUN_TIMEOUT` ([`resolveEffectiveRunTimeoutCeiling`](../../packages/runtime/src/timeout-policy.ts)), so a grant never lowers it. Deploy validation, the worker's check before execution, and the stalled-run cutoff all use the effective ceiling.

## Grant the ceiling

The automation must be deployed before it can get a grant.

1. Deploy it with a `runtime.timeout` within the platform ceiling:

   ```bash
   swizzle apply ./nightly-reconciliation
   ```

2. Grant the higher ceiling:

   ```bash
   swizzle timeout-grant set nightly-reconciliation 3h --note "nightly reconciliation"
   ```

   Setting the same ceiling again answers `already granted (no-op)`.

3. Set `runtime.timeout: 3h` in `config.yaml` and deploy again:

   ```bash
   swizzle apply ./nightly-reconciliation
   ```

## Inspect or remove a grant

```bash
swizzle timeout-grant
swizzle timeout-grant show nightly-reconciliation
```

Every change writes an audit record, and `swizzle inspect <automation>` shows the active grant. `swizzle timeout-grant` lists every grant in the environment.

To remove a grant, name the automation exactly and confirm with `--yes`. Removing a grant that does not exist answers `no grant (no-op)`.

```bash
swizzle timeout-grant remove nightly-reconciliation --yes
```

A deployment whose `runtime.timeout` exceeds the remaining ceiling then fails the worker's check before its next run. Lower `runtime.timeout` and deploy again.

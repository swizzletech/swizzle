# Agent Workflows — Multi-Stage Pipelines and Orchestration

The durable primitives in [SDK Usage — durable execution](sdk.md#durable-execution-primitives) are the *mechanism*. This file is the design layer above them: how to split a job that spans several heavy stages — or several agents — into runs that compose reliably. Reach for it when one stage produces work another stage consumes: a spec that becomes code that gets reviewed and verified, a classifier that routes to specialists, a build → review → fix loop, a fan-out of independent checks that a final stage joins.

If the whole job fits inside one run under `runtime.timeout` (ceiling 1h), you don't need any of this — write one entrypoint. This file is for when it doesn't.

Nothing here is agent-specific at the platform level. "Agent" is just the most demanding workload that exercises these shapes; the platform only ever sees runs, steps, waits, and chains.

## The two execution layers

Every orchestration decision comes down to which of two layers the work lives in.

**In-run — one stage, one live process, bounded by `runtime.timeout` (platform ceiling 1h).**
Inside a run you have a normal OS process with full compute parallelism: `Promise.all` over plain async work, several headless agent sessions at once (`claude -p`, `codex exec` as parallel subprocesses), LLM loops, judge panels, map-reduce over a list. `runStep` memoizes a result so a later retry skips it, but it does **not** suspend — control returns to your code with the value, in the same process. A live agent session can be resumed, steered, and re-prompted freely *within* the run. Everything here shares one context window and dies when the run ends.

**Cross-run — between stages, durable suspend/resume.**
`invokeAutomation`, `sleep` / `sleepUntil`, `waitForEvent`, and `requestApproval` each write a suspend sentinel to stdout and call `process.exit(0)`. The run parks in `waiting` holding no worker slot; the platform resumes it later by re-running the entrypoint from the top, with completed steps memoized so they skip. Because the process exits at the first durable wait it reaches, **durable waits are strictly sequential within a run.**

State it plainly so you never trip on it: **do not `Promise.all` over durable waits.** `Promise.all([invokeAutomation("a", …), invokeAutomation("b", …)])` does not run two children in parallel. The first call to reach the suspend calls `process.exit(0)`; the second never writes its sentinel. On resume the first child's envelope is memoized and skips, and only then does the second suspend. Net effect: the children run one after another across resume cycles, never together — and if two sentinels ever did reach stdout in one process, the second would corrupt the run result. Need N children with no ordering constraint? Invoke them sequentially and collect the envelopes. Need them genuinely parallel and joined fast? That is an in-run job (parallel subprocesses) or a static fan-out + join (below), not `Promise.all`.

**Rule of thumb: parallel work that must finish together belongs inside one stage; stages compose sequentially — by chain, by join, or by dynamic invoke.**

## The stage doctrine

**A stage is one run, which is one fresh context window.** Treat that as a feature. The reviewer stage *should not* inherit the builder's chat history — it reviews the artifact cold, unbiased by construction. Carrying a live session across a stage boundary throws that property away, and isn't supported anyway (see escalation, below).

**Clarify the unknowns regime with the user before building — it shapes every stage.** Two legitimate regimes, and which one a pipeline serves is the user's call, not a default:

- **Delivery pipeline (decision-complete work orders).** The human front-loads every decision *before* intake — spec writing, planning, trade-off calls, in whatever interactive tool they like; the pipeline neither knows nor cares — precisely to minimize unknown unknowns about the solution. The pull request is the *downstream* veto. In between, no stage owns a decision and no stage asks: residual ambiguity — there is always some, a spec is terrain, not an exact map — gets the smallest defensible choice, made by the build agent and documented prominently in its summary so the human sees it exactly where they already look (the PR). Do not put an approval gate in the middle to compensate for an under-decided spec; fix the spec process instead. (`requestApproval` mid-pipeline is for flows whose *domain* requires sign-off — publishing, spending money — not for ambiguity handling.)
- **Exploratory loop (unknowns welcome).** The goal is to *discover* the solution shape, not deliver a decided one: try approaches, keep what survives, throw the rest away. Different guardrails apply — hard budget/iteration caps instead of a spec contract, throwaway branches instead of PR-ready ones, and a judge stage whose job is comparing attempts rather than verifying requirements.

**Stages are composable blocks, and the graph lives in config, not code.** Each stage's entrypoint reads a payload and returns a result; which stage feeds which is entirely the chain declarations in `config.yaml`. Two rules make blocks swappable: (1) preserve the **work-order envelope** (`repoUrl`, `baseBranch`, `specRef`, `options`), and once a mutating stage creates a **workspace pointer** (`branch`, `sha`), every downstream stage preserves that too — a stage may append fields (findings, verdicts) or deliberately advance `sha`, but never drops the durable coordinates; (2) keep each stage indifferent to *who* produced its input. Then adding, removing, or replacing a block — drop the reviewer because an external PR bot reviews instead, insert a validator before the build, swap the e2e stage for your own — is a chain-source edit, not an entrypoint refactor. The deployable block set with compose recipes is the [agent-pipeline](https://github.com/swizzletech/swizzle/tree/main/infra/examples/agent-pipeline) example in the Swizzle repository.

**Handoffs carry artifacts, never session state.** What crosses a stage boundary must be durable, JSON-serializable, and re-fetchable from scratch:

| Handoff | Carry this | Not this |
|---|---|---|
| Code | `{ repoUrl, branch, sha }` | a worker-local checkout path |
| Findings | a JSON array/object | the reviewer's chat transcript |
| A report / document | a storage ref (S3 key, Drive file id) | the bytes inline, or a temp-file path |
| A spec | a ref to where it lives | the drafting session |

Never hand across a boundary: a worker-local filesystem path (the next stage runs elsewhere, on cleaned scratch — see [Storage decision rule](../SKILL.md#storage-decision-rule)), a chat transcript, or a live process/session handle. None of these survive a suspend, and none mean anything to a fresh run.

**Structure at machine boundaries, free text at model boundaries.** The envelope of a handoff is structured because deterministic code routes it — the join payload, a `{ decision: "ship" }` line the entrypoint parses, a findings array it merges. The *content* a model hands to the next model — the spec, a build summary, a finding's reasoning — stays prose. Don't impose a schema or required sections on it: the consumer is a language model that reads text natively, long content under a forced schema fails in truncation and format-contortion ways plain prose doesn't, and the structure buys nothing downstream. When an agent stage must emit something code will parse, confine the contract to the minimum — one strict-JSON final line, everything above it free — rather than structuring the whole output. Corollary for prompts: never assume an input format ("expect these sections"); instruct the agent to extract what it needs from whatever shape arrives ("derive the checkable requirements from the spec, however it is written").

**Escalation is a stage boundary, not a pause inside a session.** When an in-stage agent hits a question that needs a human or a slow external answer, the shape is:

1. The stage *ends*, returning an artifact like `{ status: "escalated", question, workState: { branch, sha } }`.
2. The run suspends on `waitForEvent` / `requestApproval` (or a downstream stage owns the wait).
3. After the answer arrives, a *fresh* agent session starts with `question + answer + workState` as input, re-clones the SHA, and continues.

Session continuity across a suspend is not needed for this and is not supported doctrine. (Honest footnote: a CLI session id *could* technically be placed in a handoff and resumed — but only if the exact same worker and its local session store were guaranteed for the resume, which the platform does not guarantee. Do not build on it. Re-hydrate from the artifact instead.)

## Orchestration model catalog

The classic agent-orchestration patterns, each mapped to the layer it lives in and the primitive that implements it. Pick by where the work sits, not by the name.

| Model | Layer | Swizzle shape |
|---|---|---|
| Prompt chaining | either | `runStep` sequence in one stage, or chain-triggered stages |
| Routing | in-run | classify, then `invokeAutomation` the chosen specialist |
| Parallel sectioning | in-run | `Promise.all` over `runStep`s / parallel agent subprocesses |
| Voting / judge panel | in-run | N parallel LLM calls or sessions + aggregate |
| Evaluator-optimizer loop | in-run (bounded) | generate-step + judge-step loop with a cost guard |
| Autonomous agent | in-run | headless CLI session (brings its own tools) or your own LLM loop |
| Human-in-the-loop | cross-run | `requestApproval` / `waitForEvent` |
| Orchestrator-workers (dynamic) | cross-run | `invokeAutomation` — sequential, depth ≤ 8; use only when composition is decided at runtime |
| Static fan-out + join | cross-run | multiple chain triggers on one source; join stage via `sources:` (see below) |

- **Prompt chaining** — a fixed sequence where each step's output feeds the next. Small and always-in-one-run? A `runStep` chain. Steps that are individually heavy, separately retryable, or worth their own dashboard entry? Split into chain-triggered stages.
- **Routing** — classify the input, then dispatch to a specialist. The classify decision is in-run; the dispatch is a handoff — `invokeAutomation` the chosen child (durable, you want its result) or, if the specialist is cheap, inline it as a `runStep`.
- **Parallel sectioning** — independent subtasks that all run and all finish together. In-run: `Promise.all` over `runStep`s, or fan out parallel agent subprocesses and await them.
- **Voting / judge panel** — N takes on the same question, then aggregate (majority, best-of, threshold). In-run, same as sectioning; the aggregation is your code.
- **Evaluator-optimizer loop** — generate, judge, refine, repeat until a bar is met. In-run, but **bounded**: a hard max-iterations and a cost guard, or a runaway agent bills forever. See cost guards below.
- **Autonomous agent** — hand an objective to something that plans its own steps. A headless CLI session (it brings file reads, search, shell, sometimes its own MCP tools) or your own LLM-with-tools loop. In-run; it dies with the stage.
- **Human-in-the-loop** — a decision only a person can make. Cross-run: `requestApproval` (approve/reject) or `waitForEvent` (arbitrary resolver payload). The run waits without holding a slot.
- **Orchestrator-workers (dynamic)** — a coordinator that decides *at runtime* which children to spawn and with what payloads. `invokeAutomation`, one child at a time (durable waits are sequential), depth capped at 8. Use this only when the composition genuinely can't be written as a static graph.
- **Static fan-out + join** — a known set of independent stages run off one upstream, and a final stage that needs all their results. Multiple chain triggers on the shared source, plus a join stage (next section).

Decision rules, in order:

- **Composition known ahead of time → chain triggers.** A fixed pipeline (`A → B → C`, or `A → {B, C} → join`) is a static graph. Wire it with chain and join triggers; each stage is independently visible, retryable, and testable. This is the default.
- **Composition decided at runtime, or a fix-loop with runtime-chosen children → `invokeAutomation`.** When the parent must inspect data to decide which child to call, or loop calling children until a condition holds, use dynamic invoke. Sequential, depth ≤ 8.
- **Everything parallel-and-joined-fast → inside one stage.** If the parallel parts finish in seconds-to-minutes and must be aggregated immediately, don't cross a run boundary at all. `Promise.all`, parallel subprocesses, judge panel — one run, one result.

## The join trigger

A join stage fires once when *every* named source has succeeded for the same origin — the fan-in half of static fan-out. It ships as an extension of the chain trigger.

```yaml
trigger:
  type: chain
  sources: [reviewer, e2e-verifier]   # 2+ distinct automation names; mutually exclusive with source
  on: all-succeeded                    # v1: only allowed value with sources
  payload: results                     # v1: only allowed value with sources
```

Semantics:

- **Fires exactly once per origin run**, when every automation in `sources` has a `succeeded` run correlated to the same origin — the run that chain-triggered those sources.
- **Payload shape:** `{ origin: { automation, runId }, results: { <sourceName>: <result>, ... } }`. Each `results[name]` is that source run's stdout JSON.
- **Correlation requires a common upstream.** The sources must themselves be chain-triggered from one shared origin run, so the platform can tie their completions back to the same fan-out. Independently-triggered automations that happen to share a name in `sources` will not correlate.
- **Dead-letter blocks the join (v1).** If any source dead-letters, `all-succeeded` never fires — the join stage simply doesn't run. Pair the sources with dead-letter notification rules (see [Operations](operations.md)) so a failed branch is still visible.
- **First success wins.** The first `succeeded` run per source per origin is the one that counts toward the join; later reruns of a source for the same origin don't re-fire it.
- `sources` is **mutually exclusive with `source`.** Single-`source` chain triggers ([Config Reference — Chain](config-reference.md#chain)) are unchanged. `on: all-succeeded` and `payload: results` are the only values allowed alongside `sources` in v1.

Field-level contract and constraints: [Config Reference — Chain / join](config-reference.md#join-fan-in-on-multiple-sources).

## Sandbox doctrine — repo work inside stages

When a stage clones and mutates a repository (the common case for a build or fix stage), the git remote is the durable store and the local checkout is disposable.

- **Clone ephemerally — into a subdirectory.** A deployed run's cwd is `/automation`, the bundle on a read-only file system, so a clone into the cwd fails. `$SWIZZLE_RUN_TMP` (`/tmp`) is the run's writable scratch directory; it's deleted after the run ends (success, failure, timeout, or cancel). Clone into a subdirectory of it and run all repo commands there:

  ```bash
  git clone --depth 50 "https://x-access-token:${GIT_TOKEN}@github.com/<owner>/<repo>.git" "$SWIZZLE_RUN_TMP/repo"
  # subsequent git/agent commands: cwd = $SWIZZLE_RUN_TMP/repo
  ```

  Never keep a long-lived checkout on the worker filesystem, and never treat it as durable.

- **Single-branch clones don't know the base branch.** A stage that clones the work branch (`--branch "$BRANCH"`) and then wants `git diff origin/main...$SHA` will hit "unknown revision": the clone's fetch refspec is restricted to the cloned branch, and a plain `git fetch origin main` only lands in `FETCH_HEAD`. Fetch with an explicit refspec so the remote-tracking ref exists:

  ```bash
  git fetch --depth 50 origin "$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH"
  ```

- **Push before every suspend point, inside a `runStep`.** A durable wait re-runs the entrypoint from the top on resume — an unpushed working tree is gone by then. Wrap the commit-and-push in a step whose result is the workspace pointer:

  ```typescript
  const workspace = await runStep("push-build-output", async () => {
    await sh(`git add -A`);
    await sh(`git commit -m "build stage output"`);
    await sh(`git push origin HEAD:${branch}`);
    const sha = (await sh(`git rev-parse HEAD`)).trim();
    return { repoUrl, branch, sha };
  });
  // `workspace` is now the memoized, durable pointer — return it as the handoff.
  ```

  The memoized step result is the durable workspace pointer; the remote is the durable content.

- **After resume, or in the next stage: re-clone and checkout the SHA.** A fresh run gets a clean scratch dir with no checkout. Re-cloning is idempotent by design — clone, `git checkout <sha>`, continue.

- **Never hand a filesystem path across a stage boundary.** Hand `{ repoUrl, branch, sha }`. The path is meaningless to the next run; the SHA is not.

- **PRs go through the provider REST API — `gh` is not in the runner image.** Create the PR with a direct call using the token secret:

  ```bash
  curl -sS -X POST "https://api.github.com/repos/<owner>/<repo>/pulls" \
    -H "Authorization: Bearer ${GIT_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"title\":\"...\",\"head\":\"${branch}\",\"base\":\"main\",\"body\":\"...\"}"
  ```

  Same for GitLab/Gitea/Bitbucket — their REST endpoints, the token from a declared secret.

## Headless agent sessions in a stage

A stage can *be* an agent: spawn a headless CLI session and let it work.

- **What's in the image.** The managed runner ships `claude` (`@anthropic-ai/claude-code`) and `codex` (`@openai/codex`) and the tools [Execution environment](../SKILL.md#execution-environment-whats-actually-available) lists. `gh` is **not** installed. Any other CLI needs the instance operator to add it to the runner image first. Declare each CLI under `runtime.requirements.binaries`, so `validate` confirms it before assuming.

- **Clear the binary-resolution question BEFORE deploying — per target.** The sanitized run environment has no profile `PATH`, and how a CLI was installed differs per target: the runner image puts `claude`/`codex` on the standard `PATH` (npm -g), but a local host worker may have them from the native installer or curl (e.g. `~/.local/bin`) — invisible to a hardened env. Do not hardcode `PATH` guesses and do not discover this through dead-lettered runs. The install-method-agnostic pattern: resolve once via a login shell (`bash -lc 'command -v claude && command -v node'`), spawn the **absolute path**, and add only the resolved bin dirs to the whitelisted child `PATH`. Verify resolution on the actual deploy target (`swizzle run` locally proves the local worker; the first deployed run proves the image) as part of building the automation, not after. And resolution has two more dimensions than location: **existence** — a self-hosted target may not ship the CLI at all; the fix is the instance operator adding it to the runner image and rebuilding, never installing ad-hoc inside a run — and **version**: an installed CLI can be too old for the model or flag you need (a `codex` that predates the model in `options.reviewModel` fails with a 400 at session start). Check `<cli> --version` against what the automation assumes, per target, before the first real run.

- **Vendor the agent's behavior into the automation folder.** There is no skill system inside a stage and you don't need one. Put the role/playbook prompt in a file next to the entrypoint — `PLAYBOOK.md`, `REVIEW-RULES.md`, whatever — and point the CLI at it by path:

  ```bash
  claude --dangerously-skip-permissions -p "$(cat PLAYBOOK.md)

  Task: build the change described in spec.json. When done, stop."
  ```

  That file ships with the automation bundle, so the agent's behavior is versioned with the code. This is how an automation carries reusable agent behavior — a file, not a framework.

- **Skills for the in-stage agent — only when the user wants them.** Headless sessions don't need a skill system, but if the user wants an agent to follow a specific skill, ship it in the bundle. Two mechanisms: place it as `.claude/skills/<name>/SKILL.md` inside the automation folder (the session's cwd) and Claude discovers it natively — or, more deterministic and the better default for pipelines, reference the file by path in the prompt ("Read <file> and follow it"). Native triggering depends on the model *choosing* the skill; an explicit read doesn't. Either way it's just files that deploy with the bundle — same rule as `PLAYBOOK.md`.

- **The in-stage agent can itself be an orchestrator — decide deliberately, default to one session.** Most stages need exactly one session. When a stage genuinely benefits from fan-out, two escalation levels:
  1. **Native subagents** — `claude` brings its own agent tool headless; one playbook line ("fan out subagents for independent parts") is all it takes. Zero extra plumbing.
  2. **A vendored supervisor** (e.g. a cdx-style script + role prompts, stdlib-only, shipped in the bundle) when you want detached workers, steering, or **mixed backends** — `codex` is in the runner image too. Three rules: every spawned task must be collected before the stage returns (the run's scratch dies with the run — orphaned workers are gone); each backend needs its own auth secret; the whole tree lives inside `runtime.timeout`. This is in-run supervision, never cross-run — the two-layer rule applies unchanged.

- **Read the headless-CLI traps first.** Non-interactive flags, stdout capture, credential scoping, and writable dirs — the non-obvious ones are documented once, in [Integration Gotchas — headless Claude / Codex CLI](integration-gotchas.md#headless-claude--codex-cli-in-the-worker-blocks-refuses-to-run-or-hides-its-errors). Don't rediscover them.

- **Sessions live and die with the stage.** Within a run you may spawn several, resume them, steer them, run a judge panel over their outputs. When the run ends they're gone — by design (see the stage doctrine). Persist anything that must outlive the stage as an artifact.

- **Credentials belong to the entrypoint, never the agent.** Clone, commit, push, and PR creation are deterministic entrypoint code — the agent's only job is editing files in the checkout. Spawn the headless session with an explicitly assembled environment (PATH, HOME, its own auth token, `IS_SANDBOX` — **not** `GIT_TOKEN` or any other credential it doesn't need), instead of letting it inherit the automation's env. A misbehaving agent then can't push anywhere or call any API; the worst it can do is mangle the local checkout, which the review stages and the PR merge gate exist to catch.

- **The entrypoint must push the agent's checkpoints while the agent runs.** Follow the two rules above and a non-obvious gap opens: the agent can't push (no credentials) and its local commits die with the run's scratch — so on a long stage, a timeout or crash at minute 50 silently erases everything by construction. Close it in the entrypoint: while the headless session runs, push the working branch to the remote on an interval (`setInterval(() => git push …, 5 * 60_000)`, cleared in a `finally`), and tell the agent in its playbook to commit early and often but never push. Corollary for the post-agent "did it produce anything" guard: check `git status --porcelain` **and** whether HEAD moved past your last known commit — an agent that commits its own work leaves a clean tree.

- **Guard the cost.** An agent loop with no ceiling bills until it times out or your budget is gone. Bound every loop with a hard max-iterations. Declare `runtime.rate_limits` and call SDK `pace(name)` around the model calls ([SDK Usage — rate limits](sdk.md#rate-limits-in-code)). For expensive one-shot stages, set `retry.max_attempts: 1` so a deterministic failure doesn't multiply the bill ([Recipes #12](recipes.md#12-cron-with-cost-guard)).

## Putting it together

A worked, deployable pipeline — spec → build → review + e2e → triage, config chain plus the build-stage entrypoint — is [Recipes #14: Agent pipeline](recipes.md#14-agent-pipeline-spec--build--verify--triage). Start there when you build one.

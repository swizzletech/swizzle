# Best Practices — Thinking Through Automations

Read this before building any automation. The goal: think through the full execution chain before writing a single line of code.

## The mindset

Every automation is a chain: **trigger → input → processing → external calls → output → state**. Each link has constraints, failure modes, and cost implications. Your job is to walk through this chain mentally and catch problems before they become runtime failures.

**Ask yourself at every step:** "What can go wrong here? What assumption am I making? What's the cost if this runs 10,000 times?"

## 1. Clarify intent before building

The intent-clarification questions (volume, idempotency key, bad-input policy, latency, external services, destructiveness) live in the main skill file under "Read the user before you build" — work through them there before touching this checklist. **Don't build first and ask later.** A 5-minute conversation saves hours of rework.

## 2. Execution environment

The container inventory (installed runtimes, binaries, fonts, `~/` semantics) lives in the main skill file under "Execution environment". What this section adds: the dependencies people forget per domain.

| Domain | What people forget is needed |
|---|---|
| PDF/document processing | Fonts for rendering, poppler for conversion, enough memory for large files |
| Image processing | Color profiles (CMYK→RGB), EXIF orientation, format-specific libraries |
| Audio/video | ffmpeg (not installed), codec support, large file handling |
| Web scraping | Headless browser (not installed), JavaScript rendering, session handling |
| Email (IMAP/SMTP) | TLS certificates, encoding (quoted-printable, base64), attachment size limits |
| Database access | Client libraries, connection pooling, network access to DB host |

## 3. Idempotency and state

**Every automation that runs more than once must track its state.** Without this, items get reprocessed on every trigger, wasting resources and potentially causing duplicates or corruption.

**Choose the right tracking strategy:**

| Strategy | When to use | Example |
|---|---|---|
| Content hash | File/data processing — detect actual changes | SHA256 of file bytes |
| External ID | API polling — items have stable IDs | Message ID, order number, commit SHA |
| Timestamp cursor | Time-ordered data — "everything since last run" | Last-checked-at timestamp, stored with `state_set` |
| Processed flag | Modify the source to mark completion | IMAP seen flag, database status column |

**Rules:**
- Save state after **each item**, not at the end of the batch — crash safety
- Use `claim(key)` before a side effect that must happen once per key, and `state_get`/`state_set` for cursors. A state value read in one run cannot deduplicate against a run that started at the same time
- Write ephemeral files only under `$SWIZZLE_RUN_TMP` (the deployed cwd `/automation` is read-only); durable files must go to external storage or the target system
- Track failures too — so broken items don't block the queue forever
- Use content hashes over filenames — names change, content is the truth

## 3a. Durable execution

Pick the platform primitive that matches the durability boundary:

| Primitive | Use it for | Do not use it for |
|---|---|---|
| `runStep` / `run_step` | Expensive or side-effectful work that should be memoized across retries inside one run | Cross-run cursors or ledgers |
| State helpers | Cross-run cursors, small JSON checkpoints | Large files, per-run retry memoization, deduplication |
| `claim` | A side effect that must happen once per key across runs, such as one confirmation per order. Each first claim restarts the entrypoint, so put the side effect after a claim in a loop inside a step | Cursors and checkpoints |
| `invokeAutomation` / `invoke_automation` | Parent/child composition where the parent waits for a result envelope | Fire-and-forget fanout |
| Chain trigger | Fire-and-forget pipeline stage after another automation finishes | Waiting for a synchronous child result |
| `sleep` / `waitForEvent` / `requestApproval` | Waiting without occupying a worker slot | Hand-rolled polling loops or long local sleeps |

Rules:
- Treat each durable step as a transaction boundary. If the step body performs a side effect and then crashes before returning, that side effect can happen again on retry. Make the side effect idempotent or split it into smaller named steps.
- Use stable, unique step names per run. In loops, include the item id or index.
- Do not use worker-local files as durable ledgers. Use state for small JSON, external storage for files, and durable waits instead of polling loops.

Signatures, semantics, and caps for all of these: [SDK Usage — durable execution primitives](sdk.md#durable-execution-primitives). Resolving waiting runs from the operator side: [Operations — waiting runs](operations.md#waiting-runs-and-durable-resumes).

## 4. External service calls

Every external API call is: slow, expensive, rate-limited, and unreliable. Plan for all four. Vendor-specific planning baselines: [Operations — third-party rate limits](operations.md#common-third-party-rate-limits). Known library/protocol traps (IMAP, Gemini, LexOffice, Telegram, …): [Integration Gotchas](integration-gotchas.md).

**Cost:**
- Only call the API when there's **actual work** — never on empty polls
- Initialize clients **after** confirming there are items to process
- Batch where possible — one call with 5 items beats 5 separate calls
- Set `rate_limits` in config.yaml to pace run dispatch, and use SDK `pace(name)` for coarse in-run spacing

**Reliability:**
- APIs go down. Set appropriate `timeout` and `retry` config
- Distinguish retryable errors (429, 503, network timeout) from permanent ones (400, 401, 404)
- For permanent failures, mark the item as errored and move on
- For auth-dependent services, handle token expiry gracefully

**Data handling:**
- API responses can be unexpectedly empty, malformed, or truncated
- AI model outputs are non-deterministic — validate and sanitize before using as filenames, database values, etc.
- Large payloads (images, documents) need base64 encoding — know the API's size limits
- Paginated APIs need cursor/offset handling — don't assume all results fit in one response

## 5. Input validation and edge cases

Never trust input — whether it's a file, webhook payload, API response, or user-provided data.

**By input type:**

| Input | Common edge cases |
|---|---|
| Files | Zero bytes, corrupt, wrong extension, extremely large, special chars in name, symlinks |
| Webhook payloads | Missing fields, wrong types, duplicate deliveries, replay attacks — see [Webhook Security](webhook-security.md) |
| API responses | Empty body, HTML error page instead of JSON, rate limit response, schema changes |
| Email | Multiple encodings in one message, inline images, nested MIME parts, zero-width characters |
| User-provided strings | Unicode, RTL text, emoji, path traversal chars, SQL/HTML injection |
| Timestamps | Timezones, DST transitions, milliseconds vs seconds, string vs epoch formats |
| CSV/data files | BOM bytes, mixed delimiters, unescaped quotes, encoding (UTF-8 vs Latin-1) |

**Sanitize everything that becomes a filename, path component, or database value.**

## 6. Output and side effects

Outputs are often irreversible. Think carefully:

| Action | Risk | Mitigation |
|---|---|---|
| Rename/move file | Overwrite existing | Check existence, add counter suffix |
| Delete file | Data loss | Move to trash/archive first |
| Send message (email, Slack, Telegram) | Spam, embarrassment | Dedup by message ID, preview mode |
| Write to database | Duplicates, corruption | Upsert with unique key, transactions |
| Call external API (POST/PUT/DELETE) | Can't undo | Idempotency keys, dry-run mode |
| Create files | Disk full | Check available space, clean up old output |

**Atomic writes:** Write to a temp file, then rename. Never write directly to the final path — a crash mid-write leaves a corrupt file.

## 7. Resource and cost awareness

Automations run continuously. Small inefficiencies compound:

| Bad pattern | Impact | Better pattern |
|---|---|---|
| API call on every cron tick, even when idle | $$$, rate limit exhaustion | Check for new items first, only call API when needed |
| Loading entire file into memory | OOM on large files | Stream/chunk processing |
| No rate limit in config | Runaway costs if loop goes wrong | `rate_limits: { api_calls: "60/min" }` |
| Polling every 5s for data that changes hourly | Wasted compute, API calls, log spam | Match interval to data frequency |
| Storing full API responses in tracking | Tracking file grows forever | Store only IDs/hashes, prune old entries |

## 8. Observability

An automation without good logging is a black box. Make debugging easy from the start:

- **Log the count of items found** — the most useful single metric for polling automations
- **Log before and after each significant action** — "processing file X", "renamed to Y"
- **Include identifiers in every log** — filename, ID, hash — so you can trace a specific item
- **Structured logging via `context.log_step()`** — not print statements
- **Return a meaningful result** — not just `{"status": "ok"}` but `{"status": "ok", "processed": 3, "skipped": 12, "errors": 1}`

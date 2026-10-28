# Integration Gotchas

For starter configs, see [Recipes](recipes.md).

## Headless Claude / Codex CLI in the worker: blocks, refuses to run, or hides its errors

**Symptom:** an automation spawning `claude -p` or `codex exec` hangs until timeout, exits immediately with a permissions refusal, or fails with an empty-looking error even though something clearly went wrong.

**Why:** CLIs default to interactive prompts, their home directories are ephemeral, and Claude CLI writes many error messages to *stdout*, not stderr.

**How to avoid:**
1. **Non-interactive flag** — so the subprocess doesn't block waiting for a prompt: `claude --dangerously-skip-permissions -p "..."`, `codex exec --ask-for-approval never --dangerously-bypass-approvals-and-sandbox "..."`.
2. **Use the managed non-root sandbox** — production runs as uid `65532`; do not depend on root or on operator home files. `IS_SANDBOX=1` is only a compatibility flag for older/root host targets and is harmless when explicitly scoped to a Claude child process.
3. **`runtime.permissions.writable_dirs`**: declare extra scratch directories such as `./work` or `/tmp/tool-cache`, and configure the CLI to write there. These directories are ephemeral tmpfs mounts. The sandbox home is already writable and ephemeral.
4. **Capture both stdout and stderr.** Logging only stderr will hide the reason a run failed — include stdout in your error-path logging.
5. **Plain output format, never the event stream.** `claude -p --output-format stream-json --include-partial-messages` and `codex exec --json` emit every token delta as a JSON event line — a one-hour session produces tens of MB. The platform **bounds total captured run output** and terminates the child when the cap is crossed (`PROCESS_OUTPUT_LIMIT_EXCEEDED`) — a healthy 52-minute build died exactly this way. Stream formats exist for *live supervisors* (a process that tails and reacts, like cdx, which writes the stream to its own disk file); an automation entrypoint that only awaits the final result must use plain `-p` / plain `exec` output. Belt and braces: cap what your entrypoint forwards to the run logs (e.g. keep the last 200KB with a truncation notice) so no chatty subprocess can ever hit the platform bound.

Any CLI you invoke has to be installed in the runner image — the default ships `claude` and `codex`, and [Execution environment](../SKILL.md#execution-environment-whats-actually-available) lists the rest. Declare it under `runtime.requirements.binaries`, so `validate` confirms it.

## IMAP: fetch-then-mutate in the same iteration deadlocks with Gmail

**Symptom:** your automation iterates IMAP UIDs, calls `.fetch(uid, ...)` to pull the message, then `.store(uid, "+FLAGS", "\\Seen")` or `.move(uid, ...)` inside the same loop. First message works. Second hangs or times out. Every retry stalls at the same spot.

**Why:** Gmail's IMAP server serializes mutating commands on the same connection and doesn't always tolerate interleaving FETCH and STORE/COPY/MOVE against a sequence that's actively changing. Other IMAP servers are more forgiving but still can deadlock under load.

**How to avoid:**
1. **Pull first, mutate second.** Collect every `(uid, message)` pair into a list. Close the iteration. Then iterate the list again and issue mutations.
2. Or use two connections: one for fetching, one for mutation.
3. Use UIDs, never sequence numbers — sequence numbers shift as messages get deleted.
4. Handle the quirk where expunging one message can change the UIDVALIDITY contract across sessions.

```python
# BAD — interleaves fetch and mutate
for uid in mailbox.search(["UNSEEN"]):
    message = mailbox.fetch(uid)
    process(message)
    mailbox.move(uid, "Processed")   # hangs on Gmail

# GOOD — fetch all, then mutate all
uids = list(mailbox.search(["UNSEEN"]))
messages = [(uid, mailbox.fetch(uid)) for uid in uids]
for uid, message in messages:
    process(message)
for uid, _ in messages:
    mailbox.move(uid, "Processed")
```

Applies equally to imaplib, imap_tools, and most language bindings on top of RFC 3501.

## Gemini API: JSON mode requires `response_mime_type`, not only a system prompt

**Symptom:** you ask Gemini for JSON in the prompt, the model returns prose with a JSON block inside (or wraps in markdown fences). Parsing fails intermittently.

**How to avoid:** set the generation config explicitly:

```python
response = model.generate_content(
    prompt,
    generation_config={
        "response_mime_type": "application/json",
        "response_schema": schema,   # optional but recommended
    },
)
```

Same for `@google/generative-ai` in Node — pass `responseMimeType: "application/json"` in `generationConfig`. Without it, JSON compliance is best-effort.

## Telegram Bot API: `sendMessage` HTML parse mode is stricter than you think

**Symptom:** occasional 400 "can't parse entities" when messages contain `<`, `&`, or an unclosed tag.

**How to avoid:** always HTML-escape dynamic content before embedding:

```python
import html
message = f"<b>Run failed:</b> {html.escape(error_message)}"
```

And don't rely on the message text alone to determine if the bot has been blocked — check the error code (403 Forbidden → user blocked the bot). Log and give up on 403, retry on 429/5xx.

## LexOffice API: `/v1/contacts?name=...` is fuzzy and pattern-aware

**Symptom:** searching by company name returns zero or multiple contacts even though the input looks exact.

**Why:** LexOffice's `name` filter is fuzzy, requires at least 3 characters, and treats `_` / `%` as wildcards.

**How to avoid:**
1. Treat 0 matches and >1 matches as hard errors, not soft fallbacks.
2. Accept an explicit `contactId` override in the automation input when the caller already knows the target contact.
3. Escape or avoid wildcard-heavy input, and don't assume the API is doing exact equality.

## LexOffice API: there is no reliable "paid since" query

**Symptom:** you want "all invoices paid since X" and the obvious filter surface does not exist.

**Why:** LexOffice exposes invoice-date-oriented filtering, not a dedicated "paid_at >= ..." query that is sufficient for incremental sync on its own.

**How to avoid:**
1. Query with a 90–120 day lookback window instead of assuming a precise paid-since cursor.
2. Deduplicate client-side with persisted state keyed by invoice/payment identity.
3. Persist that state only after the downstream side-effect succeeds, so retries stay idempotent.

## LexOffice API: vouchers are write-only until scanned

**Symptom:** you POST a voucher via `/voucher`, the API returns 201 with an ID — but the voucher isn't editable, categorizable, or attached to any invoice until it's been processed server-side.

**How to avoid:**
1. Treat voucher create as fire-and-forget. Don't immediately GET/PATCH by that ID.
2. For "received invoice"-style flows, use `/files` to upload the PDF and link it, not `/voucher`.
3. Match vouchers to later invoice records via external IDs (idempotency keys, not voucher IDs).

## Anthropic API: prompt caching needs at least 1024 tokens in the cached block

**Symptom:** you mark a system prompt with `cache_control` but cache hits never show up in `usage.cache_read_input_tokens`.

**How to avoid:** the cached block must be ≥ 1024 tokens for Sonnet/Opus (2048 for Haiku). Under that, the API silently skips caching. If your system prompt is short, pad with stable reference material (docs, examples, schemas) — caching is tokens, not concepts.

## AssemblyAI: `speech_model` is deprecated — it's `speech_models` (an array)

**Symptom:** `POST /v2/transcript` returns 400 with `speech_model is deprecated. Use "speech_models" instead.` Every retry fails identically, so the run burns all attempts and dead-letters.

**How to avoid:** pass an array, not a string:

```python
body = {"audio_url": url, "speech_models": ["universal-3-5-pro"], "language_code": "de"}
```

Two follow-on traps:

1. **Omitting the field is not neutral.** The default is `["universal-3-5-pro", "universal-2"]` — AssemblyAI silently falls back to the weaker model for languages the Pro model doesn't cover. If you care which model ran, name exactly one.
2. **Verify what actually ran.** The completed transcript carries `speech_model_used`. Report that rather than echoing your own config — otherwise a silent fallback is invisible.

Diarization is requested separately with `speaker_labels: true`. Prefer `speaker_options.min_speakers_expected` / `max_speakers_expected` over a hard `speakers_expected`: a third person on the call (colleague, decision-maker) degrades diarization badly when the count is pinned. Note that diarization can still merge two voices into one label — an IVR greeting and the human who follows often land on the same speaker. No prompt downstream can split them again.

## Close CRM: recordings live behind the API host, and webhook signatures need user code

**Symptom (recordings):** you expect `recording_url` to be a signed CDN link and plan around expiry. It isn't — it's `https://api.close.com/call/<activity_id>/recording/`, served from the API host.

**How to avoid:** fetch it with the same Basic auth as the rest of the API (key as username, empty password). Write the download to try unauthenticated first and retry with auth on 401/403, and gate the authenticated retry on the host actually being `*.close.com` so the key never goes to a third-party host if Close changes where recordings live.

**Symptom (webhooks):** you set `trigger.signature` with `header: close-sig-hash` and every request is rejected.

**Why:** `trigger.signature` only computes `HMAC-SHA256(rawBody)` with the secret as a UTF-8 key. Close signs `close-sig-timestamp + rawBody` and hex-decodes the signing key first, so the platform check can never match. The headers themselves are forwarded — `close-sig-hash` and `close-sig-timestamp` arrive in `SWIZZLE_WEBHOOK_HEADERS` like any other header — but the scheme needs user code.

**How to avoid:** verify in the automation with `get_webhook_headers()` + `get_raw_body()`, hex-decoding the key and prefixing the timestamp before the HMAC. Keep the baseline controls underneath it: unguessable path, `payload_schema`, and treating the payload as untrusted — take only `object_id`, validate it against a strict pattern before it enters a URL path, and re-fetch the object from the Close API. A forged request then triggers at most a lookup, never an injection.

## Fetch / undici: streaming response bodies time out at 5 min by default

**Symptom:** long SSE connections or streaming downloads drop at the five-minute mark with no explicit error.

**How to avoid:** pass `keepalive: true` and an explicit `signal: AbortSignal.timeout(<ms>)` with your own timeout, or use `undici.Agent` with `bodyTimeout` set appropriately. Also: the stream's `ReadableStream` needs to actually be consumed or Node garbage-collects the socket early.

---

Template for new entries:

```markdown
## <Protocol/API>: <one-line symptom>

**Symptom:** what the failure looks like from outside

**Why:** the underlying reason (if known)

**How to avoid:** concrete rule or code snippet
```

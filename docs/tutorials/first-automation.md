# Build your first automation

In this tutorial, we build `greeter`, a Python webhook automation that answers a name with a greeting. We run it on your machine, break it with a bad payload, make the platform reject that payload before our code runs, and then deploy it to your instance. Until the deploy step, you need no running instance, only Node.js 22.18 or later, Python 3, and the `swizzle` CLI from npm:

```bash
npm install --global @swizzletech/cli
```

## Create the automation

First, scaffold a Python automation in an empty directory:

```bash
swizzle init greeter --template python
cd greeter
```

The CLI prints `Automation scaffold created` and lists the files it wrote: `config.yaml`, `README.md`, `flow.mermaid`, `sample-payload.json`, `swizzle_sdk.py`, `main.py` and `check.py`.

## Run it

Run the scaffold as it is:

```bash
swizzle run .
```

The first line starts with `{"level": "info", "message": "received webhook payload"`. That is a log line on stderr. Below it, the CLI reports the run with `status: succeeded`, and under `result:` it shows the JSON our code wrote to stdout, starting with `status: ok` and `automation: greeter`. The run used `sample-payload.json`, because we passed no payload.

## Make it greet

Replace `main.py` with this:

```python
#!/usr/bin/env python3
from swizzle_sdk import AutomationContext, run_automation


def handle(context: AutomationContext) -> dict:
    name = context.payload["name"]
    context.log_step("greeting", {"name": name})
    return {"greeting": f"Hello, {name}!"}


if __name__ == "__main__":
    raise SystemExit(run_automation(handle))
```

Replace the content of `sample-payload.json` with `{"name": "Ada"}`, and run again:

```bash
swizzle run .
```

The result now reads:

```text
result:
  greeting: "Hello, Ada!"
```

## Break it

Send a payload without a name:

```bash
swizzle run . --payload '{}'
```

Python raises `KeyError: 'name'`, and the CLI ends with:

```text
error: Automation exited with code 1.
code: PROCESS_EXIT_NON_ZERO
```

A deployed automation would fail the same way, and the platform would retry it, although no retry can succeed.

## Reject bad input before the code runs

Open `config.yaml`. The `trigger` already holds the `type`, `path` and `signature` that `swizzle init` wrote. Add a `payload_schema` below them:

```yaml
trigger:
  type: webhook
  path: /hooks/greeter-3f9c1a7e5b2d8c4f6a0e9b1d # the random token differs in your folder
  signature:
    secret: GREETER_SIGNING_SECRET
    header: x-swizzle-signature
    prefix: sha256=
  payload_schema:
    type: object
    required: [name]
    properties:
      name:
        type: string
```

Send the empty payload again:

```bash
swizzle run . --payload '{}'
```

This time our code does not start. The CLI answers:

```text
error: "Payload does not match trigger.payload_schema: / must have required property 'name'"
code: WEBHOOK_PAYLOAD_INVALID
```

A deployed webhook rejects the same payload before it creates a run. Run `swizzle run .` once more, and the greeting for Ada comes back.

## Deploy it

Now we run `greeter` on your instance, in Swizzle's restricted Docker sandbox. You need a [running instance](../how-to/install.md) and the CLI [connected to it](../how-to/install.md#connect-the-cli). From here on, `swizzle validate` checks the folder against that instance.

The webhook checks each request's signature with the secret that `config.yaml` names, `GREETER_SIGNING_SECRET`. The instance refuses an automation until every secret it declares is stored, so store it first:

```bash
export GREETER_SIGNING_SECRET="$(node -e "console.log(crypto.randomBytes(32).toString('hex'))")"
swizzle secret set GREETER_SIGNING_SECRET --value-env GREETER_SIGNING_SECRET
```

Then validate the folder and deploy it:

```bash
swizzle validate .
swizzle apply .
```

`validate` now reports `readiness: ready (the target's workers)` and, under `deployment:`, `action: create`. `apply` reports the new deployment with `action: create` and prints `webhookUrl`, the address a sender posts signed requests to.

Start a run on the instance:

```bash
swizzle trigger greeter --payload '{"name": "Ada"}'
```

The CLI answers with the run's `id` and `status: queued`. A manual run needs no signature, and it checks the payload against `payload_schema` as the webhook does. Watch it to the end with the id it printed:

```bash
swizzle logs --run <run-id> --follow
```

The worker ran our code in the sandbox. The output ends with the run's `status: succeeded` and the greeting our code wrote to stdout:

```text
stdout: "{\"greeting\": \"Hello, Ada!\"}\n"
```

We built an automation, ran it with a sample payload and an inline one, made the platform enforce its input, and ran it deployed. To use state, durable steps and waits, continue with [write an automation](../how-to/write-an-automation.md).

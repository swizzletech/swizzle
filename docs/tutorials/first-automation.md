# Build your first automation

In this tutorial, we build `greeter`, a Python webhook automation that answers a name with a greeting. We run it on your machine, break it with a bad payload, and then make the platform reject that payload before our code runs. You need no running instance, only Node.js 22.18 or later, Python 3, and the `swizzle` CLI from npm:

```bash
npm install --global @swizzletech/cli
```

## Create the automation

First, scaffold a Python automation in an empty directory:

```bash
swizzle init greeter --template python
cd greeter
```

The CLI prints `Automation scaffold created` and lists the files it wrote: `config.yaml`, `main.py`, `swizzle_sdk.py`, `sample-payload.json`, `flow.mermaid` and `README.md`.

Now, check the folder:

```bash
swizzle validate .
```

The last lines read `readiness: ready` and `syntax: ok (compile)`. The syntax check does not write `__pycache__` into the automation folder.

## Run it

Run the scaffold as it is:

```bash
swizzle run .
```

You see two lines. The first starts with `{"level": "info", "message": "received webhook payload"`. That is a log line on stderr. The second is the result on stdout, a JSON object that starts with `{"status":"ok","automation":"greeter"`. The run used `sample-payload.json`, because we passed no payload.

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

The last line is the result:

```json
{"greeting":"Hello, Ada!"}
```

## Break it

Send a payload without a name:

```bash
swizzle run . --payload '{}'
```

Python raises `KeyError: 'name'`, and the CLI ends with:

```text
Error [PROCESS_EXIT_NON_ZERO]: Automation exited with code 1.
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
Error [WEBHOOK_PAYLOAD_INVALID]: Payload does not match trigger.payload_schema: / must have required property 'name'
```

A deployed webhook rejects the same payload before it creates a run. Run `swizzle run .` once more, and the greeting for Ada comes back.

We built an automation, ran it with a sample payload and an inline one, and made the platform enforce its input. To deploy it and to use state, durable steps and waits, continue with [write an automation](../how-to/write-an-automation.md).

# Add a remote worker

A remote worker is another machine that runs an instance's automations. It runs the worker, its Docker broker, the runner base image, both egress proxies, and the named-service gateway from [`compose.worker.yml`](../../infra/docker/compose.worker.yml). It holds one worker credential. It has no PostgreSQL, Valkey, encryption key, or artifact store. It pulls work from the instance's API over HTTPS and receives the bundle and inputs for an accepted attempt. It receives that attempt's declared secrets and connection tokens when execution starts ([worker protocol](../reference/worker-protocol.md)).

The stack's local worker already serves every project and environment. Add a remote worker when you need capacity on another machine or need automations to run on that worker's architecture.

You need:

- An owner or instance admin account on the instance, and the `swizzle` CLI signed in to it.
- An API address the worker machine reaches over HTTPS, such as a tailnet or LAN name. A certificate from a private CA works when the worker trusts that CA (step 4).
- On the worker machine: Docker with Compose, `just`, the pinned Node version from `mise.toml`, and a checkout of this repository. Compose builds the images there, so the worker assembles run images for its own architecture.

## 1. Choose a group

A group is a `runtime.profile` name. List the groups already available to a project and environment:

```bash
swizzle worker groups --project <project> --environment production
```

The result names each group and the machines that serve it. It includes machine state, not network addresses or credentials. Anyone who can read the project can list its groups.

If no worker serves the group you need, an owner or admin must grant it in step 2. A run waits for a live worker granted that group, project and environment. It never falls back to another group.

Pin each automation that should run on the new machine:

```yaml
runtime:
  profile: build-box
```

If the machine may stay offline for more than 24 hours, set `runtime.queue_timeout` in `config.yaml`. The [config reference](../reference/config.md#runtime) lists its duration format, and the [worker protocol](../reference/worker-protocol.md#queue-wait-and-recovery) explains how placement deadlines behave.

## 2. Issue an enrollment code

On a machine signed in as owner or admin, grant the worker one project and environment and the group:

```bash
swizzle worker create build-box-1 --project <project-uuid> --environment production --groups build-box
```

The command prints a single-use code that expires after ten minutes. The worker appears under **Settings > Workers** as awaiting enrollment.

## 3. Enroll the worker

On the worker machine, pass the code through stdin:

```bash
swizzle worker enroll --api-url https://swizzle.example.ts.net --credential-file /private/path/worker.env
```

Choose an existing private directory outside the repository so the Docker build cannot copy the credential. The command writes `/private/path/worker.env` with mode 0600 and never overwrites an existing file. The file holds the API address, the worker token and a separate random token for the local inference gateway control listener. Keep it outside automation bundles and out of version control.

## 4. Start the worker stack

From the repository root on the worker machine:

```bash
just worker /private/path/worker.env
```

The command uses Docker's selected context, checks for a Linux amd64 or arm64 engine, builds native images and waits for service health. If it cannot reach the engine, start your Docker runtime and check `docker context show`. Remove a conflicting `DOCKER_DEFAULT_PLATFORM` setting. The broker mounts `/var/run/docker.sock` inside the engine, so do not replace it with your macOS client's socket path.

The stack copies the enrollment credential into its private `worker-credentials` volume once. The worker renews its token automatically during its last seven days of validity, including at startup after time offline. Renewal survives a dropped response and stores the replacement in that volume with mode 0600. Keep the volume across restarts. The original `/private/path/worker.env` remains a bootstrap file; it does not receive later tokens. Do not start two stacks from the same worker credential.

The control egress proxy allows the host and port of `SWIZZLE_WORKER_API_URL`, also on a private address, so the worker reaches the API while sandboxed runs cannot. When the API uses a certificate from a private CA, add a Compose override that mounts the CA certificate into the worker and sets `NODE_EXTRA_CA_CERTS` to its path. Pass the override as `just worker /private/path/worker.env /absolute/path/to/override.yml`.

Within a minute **Settings > Workers** shows the worker online. Deploy an automation pinned to the group and trigger it. While it runs, **Settings > Workers** lists it under the machine. Its logs and result appear in the dashboard as for the local worker.

A queued run reports why no worker has taken it, which machines could serve it, and its deadline. `swizzle runs inspect` prints the group, wait reason, and deadline. The run page and `swizzle diagnose` suggest a next action when no worker serves the group, workers are offline, or the local LLM is unhealthy.

## Use a MacBook

Select your runtime with `docker context use <context>` before starting the stack. A combination counts as validated once a MacBook with it has run deployed automations, slept with the lid closed, and had its Docker runtime stopped and restarted:

| Runtime | Engine selection | Intel Mac | Apple Silicon Mac |
|---|---|---|---|
| Docker Desktop | Its Docker context | Untested | Validated: Docker Desktop 4.73.0, engine 29.4.3 `linux/arm64`, macOS 26.5.2 |
| OrbStack | Its Docker context | Untested | Untested |
| Colima | Its Docker context | Untested | Untested |

The startup command uses the context's endpoint rather than guessing a socket from the runtime's name. Both architectures build their own worker, broker, proxies and runner base. Deployed code runs inside Linux containers. Native macOS tools such as Xcode are outside this execution contract.

Give the Docker VM enough memory for the worker, proxies and each concurrent sandbox. The worker-only stack defaults to one execution slot, a 1 GiB run ceiling and one CPU per run. It also limits worker memory, CPU and processes. Adjust the settings in [`compose.worker.yml`](../../infra/docker/compose.worker.yml) and [`execution.yml`](../../infra/docker/execution.yml) to your VM's budget before starting. These are per-container ceilings; Docker's VM settings bound the machine's total use, including image builds.

After the Mac sleeps, its worker waits until the Mac has stayed awake for 90 seconds before pulling new work. A DarkWake that lasts longer than 90 seconds can pass the gate while the lid is closed, and a later sleep can interrupt that run. A pinned run that waits for its worker stays queued until its queue timeout. If sleep interrupts a run, the server applies its retry policy on the same group. External effects can happen more than once. See [worker protocol](../reference/worker-protocol.md#queue-wait-and-recovery) for sleep detection and lease recovery.

Keep local cache volumes between starts. Native dependency installations stay inside the engine's run images; the build cache is split by architecture. The worker prunes only its stack's unused run images by age and disk budget. Active deployment images can exceed that budget because pruning keeps them. **Settings > Workers** and the Overview's Needs you list show an overage. `swizzle worker list` lists it under `warnings`. The [security model](../explanation/security-model.md#a-run-gets-only-what-it-declared) explains the warning and its remedies. To reduce the active image total, remove deployments the worker serves and let preparation reconcile. To keep those deployments, raise `SWIZZLE_RUNNER_IMAGE_DISK_MB` on the worker and restart it. If you remove the worker, revoke it and remove its stack. See [worker host cleanup](install.md#clean-up-a-worker-host) before pruning images on a shared engine.

To stop without deleting the credential and cache volumes:

```bash
docker compose -p swizzle-worker -f infra/docker/compose.worker.yml --env-file /private/path/worker.env down
```

Use your chosen project name if you set `COMPOSE_PROJECT_NAME`. A stopping worker finishes its runs for up to 30 seconds. A run that takes longer is cut off and retries under its retry policy, and the worker removes what it left when it starts again. Start again with `just worker /private/path/worker.env`. An expired or revoked token needs owner re-enrollment; the worker cannot renew after its validity ends.

## Remove a worker

Revoke it under **Settings > Workers** or with `swizzle worker revoke <id>`. The API refuses its next request. A run it held retries on another worker of the group under the run's retry policy, or waits for one. Revocation cannot erase values the machine already received, so rotate the secrets of the projects it served when you no longer trust it.

## Call a local LLM on this worker

1. Run an authenticated OpenAI-compatible model server on the GPU host. It must serve `GET /health` and `POST /v1/chat/completions`. Bind it to the host interface the gateway reaches and require an API key.
2. When issuing the worker's enrollment, add `--local-llm` to `swizzle worker create`, or select **Allow local LLM inference** in **Settings > Workers**. The grant applies within that worker's approved project and environment. Use a dedicated group such as `gpu-home`.
3. Add the following to the enrolled machine's private `worker.env`, then start its Compose stack as above:

   ```dotenv
   SWIZZLE_LOCAL_LLM_UPSTREAM=http://172.17.0.1:8080
   SWIZZLE_LOCAL_LLM_API_KEY=<upstream API key>
   SWIZZLE_LOCAL_LLM_MODEL=<installed model id>
   ```

   Replace the example IP and port with the exact address reachable from Docker on that host. A DNS name is refused. The upstream key stays in the gateway. The enrollment file already contains `SWIZZLE_LOCAL_LLM_CONTROL_TOKEN`.
4. Request the service in the automation:

   ```yaml
   runtime:
     profile: gpu-home
     permissions:
       network: true
       services: [local-llm]
   ```

5. Send a JSON `POST` to `SWIZZLE_LOCAL_LLM_URL` with `Authorization: Bearer <SWIZZLE_LOCAL_LLM_TOKEN>` and a `messages` array of text `{role, content}` objects. Optional `max_tokens` and `temperature` fields are accepted. The gateway selects the configured model. It rejects tools, model overrides, other paths and redirects.

The gateway bounds parallel requests, requests per attempt and output tokens with `SWIZZLE_LOCAL_LLM_CONCURRENCY`, `SWIZZLE_LOCAL_LLM_REQUESTS` and `SWIZZLE_LOCAL_LLM_MAX_TOKENS` in `worker.env`. Each attempt can have one request active. Worker heartbeats report `services.local-llm` as `healthy`, `unhealthy` or `disabled`. A run requiring the service waits while no approved worker reports it healthy, under its usual `queue_timeout`.

The instance's default Local worker has no service grant. A deploy is refused while no worker of the automation's group is granted the service, and the refusal names each worker of the group that lacks it. Enroll a worker in the dedicated group on the GPU host, including when that host also runs the instance. [The security model](../explanation/security-model.md#a-run-gets-only-what-it-declared) describes the service boundary.

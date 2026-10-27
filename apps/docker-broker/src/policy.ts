// What the broker lets through to the Docker daemon: exactly the calls the worker's Docker CLI
// makes (packages/runtime/src/sandbox.ts, run-image.ts, container-runner.ts, docker-cli.ts), with
// the create and exec bodies and the container list filters held to the shapes those calls send. Anything else is refused, so a new Docker
// operation in the worker fails closed until this file allows it.

/** The stack the broker serves. */
export interface BrokerScope {
  /** Every container and image the broker touches carries the label swizzle.stack=<stack>. */
  readonly stack: string;
  /** The run network a container may join; the only other network mode is none. */
  readonly runnerNetwork: string;
  /** The most memory a container may get: SWIZZLE_MAX_RUN_MEMORY_MB, as the worker reads it. */
  readonly maxMemoryBytes: number;
  /** The most CPUs a container may get, in billionths: SWIZZLE_MAX_RUN_CPUS, as the worker reads it. */
  readonly maxNanoCpus: number;
}

/**
 * The scope from the variables the worker reads too, or why they do not make one. A maximum must
 * be finite and positive in its unit, so a typo cannot lift the broker's limit to infinity.
 */
export function readBrokerScope(environment: NodeJS.ProcessEnv): BrokerScope | string {
  const stack = environment.SWIZZLE_STACK?.trim() ?? "";
  const runnerNetwork = environment.SWIZZLE_RUNNER_NETWORK?.trim() ?? "";
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(stack)) return "SWIZZLE_STACK must be a compose project name.";
  if (runnerNetwork === "") return "SWIZZLE_RUNNER_NETWORK is required.";
  const maxMemoryBytes = Math.floor(Number(environment.SWIZZLE_MAX_RUN_MEMORY_MB) * 1_048_576);
  const maxNanoCpus = Math.round(Number(environment.SWIZZLE_MAX_RUN_CPUS) * 1e9);
  for (const [name, value] of [
    ["SWIZZLE_MAX_RUN_MEMORY_MB", maxMemoryBytes],
    ["SWIZZLE_MAX_RUN_CPUS", maxNanoCpus],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return `${name} must be a positive number within range, not ${JSON.stringify(environment[name] ?? "")}.`;
    }
  }
  return { maxMemoryBytes, maxNanoCpus, runnerNetwork, stack };
}

/**
 * What one request needs before it reaches the daemon. `container`, `exec` and `image` name an
 * object that must carry the stack label; `create` and a container's `exec` carry a body to check.
 */
export type Route =
  | { readonly kind: "forward" }
  | { readonly kind: "create" }
  | { readonly kind: "list"; readonly filters: string }
  | { readonly kind: "commit"; readonly container: string }
  | { readonly kind: "container"; readonly container: string; readonly action: ContainerAction }
  | { readonly kind: "exec"; readonly exec: string; readonly hijack: boolean }
  | { readonly kind: "image"; readonly image: string }
  | { readonly kind: "deny"; readonly reason: string };

type ContainerAction =
  | "archive"
  | "attach"
  | "exec"
  | "inspect"
  | "kill"
  | "remove"
  | "start"
  | "stop"
  | "wait";

/** The user every sandbox and assembly container runs as (SANDBOX_USER in packages/runtime). */
const SANDBOX_USER = "65532:65532";
/**
 * The PID and open-files limits of every sandbox and assembly container (containerLimitArguments
 * in packages/runtime; broker.test.ts holds the two to the same values).
 */
const PIDS_LIMIT = 128;
const OPEN_FILES_LIMIT = 1024;
/** The repository the worker tags run images into (runImageTag in packages/runtime). */
const RUN_IMAGE_REPOSITORY = "docker.io/library/swizzle-run";

const CONTAINER_ACTIONS: Readonly<Record<string, ContainerAction>> = {
  "GET json": "inspect",
  "HEAD archive": "archive",
  "PUT archive": "archive",
  "POST attach": "attach",
  "POST exec": "exec",
  "POST kill": "kill",
  "POST start": "start",
  "POST stop": "stop",
  "POST wait": "wait",
};

export function route(method: string, rawUrl: string): Route {
  const url = new URL(rawUrl, "http://broker");
  const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/u, "");
  // Names, ids and image references never need these, and they could make the daemon's router
  // read a different path than this one.
  if (/%|\.\.|\/\//u.test(path)) return deny("the path is not in canonical form");
  const query = url.searchParams;
  const call = `${method} ${path}`;

  if (call === "GET /_ping" || call === "HEAD /_ping" || call === "GET /version") return FORWARD;
  if (call === "GET /images/json") return FORWARD;
  if (call === "GET /containers/json") {
    const filters = query.get("filters");
    if (filters === null) return deny("a container list names no label filter");
    return onlyParameters(query, ["all", "filters"]) ?? { filters, kind: "list" };
  }
  if (call === "POST /containers/create") {
    return onlyParameters(query, ["name"]) ?? { kind: "create" };
  }
  if (call === "POST /commit") {
    const container = query.get("container");
    if (container === null) return deny("commit names no container");
    return onlyParameters(query, ["changes", "container"]) ?? { kind: "commit", container };
  }
  if (call === "POST /images/create") {
    if (query.get("fromImage") === null) return deny("only a pull by fromImage is allowed");
    return onlyParameters(query, ["fromImage", "tag"]) ?? FORWARD;
  }

  const image = /^\/images\/([A-Za-z0-9._:/@-]+?)(\/json|\/tag)?$/u.exec(path);
  if (image !== null) {
    const [, reference = "", suffix] = image;
    if (method === "GET" && suffix === "/json") return FORWARD;
    if (method === "DELETE" && suffix === undefined) return { image: reference, kind: "image" };
    if (method === "POST" && suffix === "/tag") {
      if (query.get("repo") !== RUN_IMAGE_REPOSITORY) {
        return deny(`images may be tagged only into ${RUN_IMAGE_REPOSITORY}`);
      }
      return { image: reference, kind: "image" };
    }
  }

  const container = /^\/containers\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\/([a-z]+))?$/u.exec(path);
  if (container !== null) {
    const [, name = "", verb] = container;
    if (verb === undefined) {
      if (method !== "DELETE") return deny(`${call} is not an operation the worker performs`);
      return (
        onlyParameters(query, ["force"]) ?? {
          action: "remove",
          container: name,
          kind: "container",
        }
      );
    }
    const action = CONTAINER_ACTIONS[`${method} ${verb}`];
    if (action !== undefined) return { action, container: name, kind: "container" };
  }

  const exec = /^\/exec\/([a-f0-9]{64})\/(start|json|resize)$/u.exec(path);
  if (exec !== null) {
    const [, id = "", verb] = exec;
    const allowed = verb === "json" ? method === "GET" : method === "POST";
    if (allowed) return { exec: id, hijack: verb === "start", kind: "exec" };
  }

  return deny(`${call} is not an operation the worker performs`);
}

/** Whether a route may switch the connection to a raw stream (Docker's hijacked attach and exec). */
export function mayHijack(routed: Route): boolean {
  return (
    (routed.kind === "container" && routed.action === "attach") ||
    (routed.kind === "exec" && routed.hijack)
  );
}

/**
 * Why a container list's filters do not keep it to this stack, or null when they do: one label
 * filter, for the stack's sandboxes and assemblies or for its worker containers. The worker lists
 * both at start to remove what a stopped worker left (removeLeftoverContainers in packages/runtime).
 */
export function checkList(filters: string, scope: BrokerScope): string | null {
  const allowed = [`swizzle.stack=${scope.stack}`, `swizzle.worker-of=${scope.stack}`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(filters);
  } catch {
    return "the container list filters are not JSON";
  }
  return allowed.some((label) => equals(parsed, { label: { [label]: true } }))
    ? null
    : `a container list must filter by exactly one label, ${allowed.join(" or ")}`;
}

/** Whether labels mark an object of this stack. */
export function ownedBy(labels: unknown, scope: BrokerScope): boolean {
  return isRecord(labels) && labels["swizzle.stack"] === scope.stack;
}

/**
 * Why a container create body is refused, or null when it is one of the two shapes the worker
 * sends: a sandbox (sandboxSpec) or an image assembly (assembleOnce). Every key must be known, so
 * a field a later Docker CLI adds is refused until it is reviewed here.
 */
export function checkCreate(body: unknown, scope: BrokerScope): string | null {
  if (!isRecord(body)) return "the create body is not a JSON object";
  // Docker fills an omitted field with its default: the image's user, the default capabilities,
  // the bridge network, no resource limits. So the fields that confine a container must be
  // present, not merely valid.
  const missing =
    missingField("", body, ["HostConfig", "Image", "Labels", "User"]) ??
    (isRecord(body.HostConfig)
      ? missingField("HostConfig.", body.HostConfig, [
          "CapDrop",
          "Memory",
          "MemorySwap",
          "NanoCpus",
          "NetworkMode",
          "PidsLimit",
          "SecurityOpt",
          "Ulimits",
        ])
      : null);
  if (missing !== null) return missing;
  const top = checkFields("", body, {
    AttachStderr: isBoolean,
    AttachStdin: isFalse,
    AttachStdout: isBoolean,
    Cmd: isStringArrayOrNull,
    Domainname: isEmpty,
    Entrypoint: isStringArrayOrNull,
    Env: isStringArrayOrNull,
    HostConfig: isRecord,
    Hostname: isEmpty,
    Image: (value) => typeof value === "string" && value.length > 0,
    Labels: (value) => ownedBy(value, scope),
    NetworkingConfig: (value) => equals(value, { EndpointsConfig: {} }),
    OpenStdin: isFalse,
    StdinOnce: isFalse,
    Tty: isFalse,
    User: (value) => value === SANDBOX_USER,
    Volumes: isEmpty,
    WorkingDir: isEmpty,
  });
  if (top !== null) return top;
  const host = body.HostConfig as Record<string, unknown>;
  return checkFields("HostConfig.", host, {
    ...Object.fromEntries(HOST_CONFIG_EMPTY.map((key) => [key, isEmpty])),
    AutoRemove: isBoolean,
    CapDrop: (value) => Array.isArray(value) && value.includes("ALL"),
    ConsoleSize: (value) => equals(value, [0, 0]),
    Init: isBoolean,
    LogConfig: (value) => equals(value, { Config: {}, Type: "" }),
    // null keeps Docker's masked and read-only /proc paths; an empty list removes them.
    MaskedPaths: (value) => value === null,
    // Docker reads 0 as unlimited, so each limit must be set and within the platform maximum.
    Memory: (value) => isPositiveIntegerUpTo(value, scope.maxMemoryBytes),
    // Equal to Memory: the container gets no swap.
    MemorySwap: (value) => value === host.Memory,
    MemorySwappiness: (value) => value === -1,
    NanoCpus: (value) => isPositiveIntegerUpTo(value, scope.maxNanoCpus),
    NetworkMode: (value) => value === "none" || value === scope.runnerNetwork,
    PidsLimit: (value) => value === PIDS_LIMIT,
    ReadonlyPaths: (value) => value === null,
    ReadonlyRootfs: isBoolean,
    RestartPolicy: (value) => equals(value, { MaximumRetryCount: 0, Name: "no" }),
    SecurityOpt: (value) => equals(value, ["no-new-privileges:true"]),
    Tmpfs: (value) => isRecord(value) && Object.values(value).every((v) => typeof v === "string"),
    Ulimits: (value) =>
      equals(value, [{ Hard: OPEN_FILES_LIMIT, Name: "nofile", Soft: OPEN_FILES_LIMIT }]),
  });
}

/** Why an exec body is refused, or null when it runs as the container's user without privileges. */
export function checkExec(body: unknown): string | null {
  if (!isRecord(body)) return "the exec body is not a JSON object";
  return checkFields("", body, {
    AttachStderr: isBoolean,
    AttachStdin: isBoolean,
    AttachStdout: isBoolean,
    Cmd: (value) => isStringArrayOrNull(value) && value !== null && value.length > 0,
    DetachKeys: isEmpty,
    Env: isStringArrayOrNull,
    Privileged: isFalse,
    Tty: isFalse,
    User: (value) => value === "" || value === SANDBOX_USER,
    WorkingDir: isEmpty,
  });
}

// What the Docker CLI sends empty for every create the worker makes. Each of these, set, gives a
// container host access or host resources: Binds, Mounts, VolumesFrom and Devices reach host
// files; Privileged, CapAdd and the *Mode namespaces leave the sandbox; the rest tune host
// scheduling, cgroups and DNS the worker never sets.
const HOST_CONFIG_EMPTY = [
  "Binds",
  "BlkioDeviceReadBps",
  "BlkioDeviceReadIOps",
  "BlkioDeviceWriteBps",
  "BlkioDeviceWriteIOps",
  "BlkioWeight",
  "BlkioWeightDevice",
  "CapAdd",
  "Cgroup",
  "CgroupParent",
  "CgroupnsMode",
  "ContainerIDFile",
  "CpuCount",
  "CpuPercent",
  "CpuPeriod",
  "CpuQuota",
  "CpuRealtimePeriod",
  "CpuRealtimeRuntime",
  "CpuShares",
  "CpusetCpus",
  "CpusetMems",
  "DeviceCgroupRules",
  "DeviceRequests",
  "Devices",
  "Dns",
  "DnsOptions",
  "DnsSearch",
  "ExtraHosts",
  "GroupAdd",
  "IOMaximumBandwidth",
  "IOMaximumIOps",
  "IpcMode",
  "Isolation",
  "Links",
  "MemoryReservation",
  "Mounts",
  "OomKillDisable",
  "OomScoreAdj",
  "PidMode",
  "PortBindings",
  "Privileged",
  "PublishAllPorts",
  "ShmSize",
  "UTSMode",
  "UsernsMode",
  "VolumeDriver",
  "VolumesFrom",
];

const FORWARD: Route = { kind: "forward" };

function deny(reason: string): Route {
  return { kind: "deny", reason };
}

function onlyParameters(query: URLSearchParams, allowed: readonly string[]): Route | null {
  for (const key of query.keys()) {
    if (!allowed.includes(key)) return deny(`the query parameter ${key} is not allowed`);
  }
  return null;
}

function missingField(
  prefix: string,
  value: Record<string, unknown>,
  required: readonly string[],
): string | null {
  const absent = required.find((key) => !(key in value));
  return absent === undefined ? null : `${prefix}${absent} is missing`;
}

function checkFields(
  prefix: string,
  value: Record<string, unknown>,
  rules: Readonly<Record<string, (field: unknown) => boolean>>,
): string | null {
  for (const [key, field] of Object.entries(value)) {
    const rule = rules[key];
    if (rule === undefined) return `${prefix}${key} is not a field the worker sets`;
    if (!rule(field)) return `${prefix}${key} has a value the worker never sends`;
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): boolean {
  return typeof value === "boolean";
}

function isFalse(value: unknown): boolean {
  return value === false;
}

function isPositiveIntegerUpTo(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isStringArrayOrNull(value: unknown): value is readonly string[] | null {
  return (
    value === null || (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** The Docker CLI's zero values: null, false, 0, "", an empty list or an empty object. */
function isEmpty(value: unknown): boolean {
  if (value === null || value === false || value === 0 || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return isRecord(value) && Object.keys(value).length === 0;
}

function equals(value: unknown, expected: unknown): boolean {
  return JSON.stringify(sortKeys(value)) === JSON.stringify(sortKeys(expected));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

import path from "node:path";
import { z } from "zod";
import { parseQueueTimeoutToMs } from "../intervals.js";
import { WORKER_SERVICES } from "../worker-services.js";

export const AUTOMATION_RUNTIME_EXECUTION_MODES = ["host", "profile", "container"] as const;

export const AUTOMATION_RUNTIME_LANGUAGES = ["python", "node", "typescript"] as const;

export const AUTOMATION_RUNTIME_PROFILE_DEFAULT = "host-default" as const;

const AUTOMATION_RUNTIME_ON_OVERLAP_MODES = ["skip", "queue"] as const;

const retrySchema = z.strictObject({
  max_attempts: z
    .int()
    .positive()
    .default(3)
    .describe(
      "Total attempts for a retryable failure, the first attempt included. A resume after a wait starts a fresh count.",
    ),
  backoff: z
    .enum(["fixed", "exponential"])
    .default("exponential")
    .describe("How the delay between attempts grows."),
});

const runtimePermissionSchema = z.strictObject({
  network: z.boolean().default(true).describe("Whether the run may open network connections."),
  services: z
    .array(z.enum(WORKER_SERVICES))
    .default([])
    .describe(
      "Named services this run may use. local-llm requires an owner-approved worker and provides an attempt-scoped inference gateway token.",
    ),
  writable_dirs: z
    .array(
      z
        .string()
        .min(1)
        .refine((value) => !value.startsWith("~"), {
          error: (issue) =>
            `Writable directory ${JSON.stringify(issue.input)} starts with "~", which is not expanded. Write it relative to the automation folder, such as "data" for /automation/data, or as an absolute path.`,
        })
        .refine(
          (value) =>
            !value.includes("\0") &&
            !value.includes(":") &&
            !value.includes(",") &&
            !value.split(/[\\/]/u).some((segment) => segment === "..") &&
            (!path.posix.isAbsolute(value) ||
              !["/dev", "/home/swizzle", "/proc", "/run/swizzle", "/sys"].some(
                (reserved) => value === reserved || value.startsWith(`${reserved}/`),
              )),
          {
            message:
              "Writable directories must stay outside protected runtime and kernel paths, cannot traverse parents, and cannot contain mount-option delimiters.",
          },
        ),
    )
    .default([])
    .describe(
      "Directories the run may write, mounted as tmpfs in the container. A relative path resolves under `/automation`. A path may not start with `~`, traverse parents, contain `:` or `,`, or lie under `/dev`, `/proc`, `/sys`, `/home/swizzle` or `/run/swizzle`.",
    ),
});

const bundleRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      !value.includes("\0") &&
      !value.split(/[\\/]/u).some((segment) => segment === ".."),
    { message: "Dependency paths must stay inside the automation bundle." },
  );

const binaryRequirementSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .describe(
      "Executable name on the run's `PATH`: the runner image's for a deployed run, this machine's for `swizzle run`.",
    ),
  version: z
    .string()
    .trim()
    .regex(
      /^(?:>=|<=|>|<|=)?\s*\d+(?:\.\d+)*$/u,
      "Invalid version rule. Use a numeric version prefix such as 25 or 25.3, or a comparison: >=25, <=25, >25, <25, =25.3.0.",
    )
    .optional()
    .describe(
      "A bare numeric version matches a dotted prefix: `25` matches `25.03.0`, and `25.3` matches `25.03.0`. Comparisons `>=`, `<=`, `>`, `<` and `=` compare numeric components, treating omitted components as zero; `=25` means exactly `25.0.0`. Forms such as `^25` are invalid. A binary whose version the worker cannot tell fails every rule.",
    ),
});

const pythonDependencySchema = z.strictObject({
  requirements_file: bundleRelativePathSchema
    .default("requirements.txt")
    .describe("pip requirements file, relative to the automation folder."),
});

const nodeDependencySchema = z.strictObject({
  lockfile: bundleRelativePathSchema
    .optional()
    .describe("Lockfile for a reproducible install, relative to the automation folder."),
  package_json: bundleRelativePathSchema
    .default("package.json")
    .describe(
      "Manifest to install, relative to the automation folder. Lifecycle scripts do not run.",
    ),
});

const containerSchema = z.strictObject({
  base_image: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Image the automation's run image starts from. The operator trusts it; prefer a digest-pinned image.",
    ),
  cpus: z
    .string()
    .regex(/^\d+(\.\d+)?$/u, "Use a decimal number of CPUs such as 1.5.")
    .refine((value) => Number(value) > 0, "Use more than 0 CPUs.")
    .optional()
    .describe(
      "CPU limit of the run and its dependency install, for example `1.5`. Default `1.0`; deploy rejects a value above `SWIZZLE_MAX_RUN_CPUS` (default `2`, or the host's CPU count when that is smaller).",
    ),
  memory_mb: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Memory limit in MiB of the run and its dependency install, without swap. Default `512`; deploy rejects a value above `SWIZZLE_MAX_RUN_MEMORY_MB` (default `2048`).",
    ),
});

const runtimeRequirementsSchema = z.strictObject({
  binaries: z
    .array(binaryRequirementSchema)
    .default([])
    .describe(
      "Binaries the run needs. Deploy readiness needs one live worker of the group whose runner image has all of them in a matching version; the instance operator adds a missing one to the runner image.",
    ),
  node: nodeDependencySchema
    .optional()
    .describe("Node dependencies the worker installs into the automation image before the run."),
  python: pythonDependencySchema
    .optional()
    .describe("Python dependencies the worker installs into the automation image before the run."),
});

const runtimeInputSchema = z.strictObject({
  execution_mode: z
    .enum(AUTOMATION_RUNTIME_EXECUTION_MODES)
    .default("host")
    .describe(
      "How a trusted local `swizzle run` executes: `host` and `profile` as a host process, `container` in the sandbox. Production workers run every deployed run in the container sandbox.",
    ),
  language: z
    .enum(AUTOMATION_RUNTIME_LANGUAGES)
    .optional()
    .describe(
      "Inferred from the `entrypoint` extension when omitted: `.js` is node, `.ts` is typescript, anything else python.",
    ),
  on_overlap: z
    .enum(AUTOMATION_RUNTIME_ON_OVERLAP_MODES)
    .optional()
    .describe(
      "Cron triggers only: what a due tick does while a run of this automation is still active. `skip`, the default, records a skipped tick; `queue` enqueues the run anyway.",
    ),
  permissions: runtimePermissionSchema
    .default(runtimePermissionSchema.parse({}))
    .describe("Network and filesystem access; see the enforcement table below."),
  profile: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,63}$/)
    .default(AUTOMATION_RUNTIME_PROFILE_DEFAULT)
    .describe(
      "Worker group the automation runs in. A run waits for a live worker granted this group, project and environment, and never runs in another group. `swizzle worker groups` lists the groups that serve a project. Unrelated to the CLI's `--profile`.",
    ),
  queue_timeout: z
    .string()
    .refine((value) => {
      try {
        return parseQueueTimeoutToMs(value) > 0;
      } catch {
        return false;
      }
    }, "Expected a positive duration, such as 24h.")
    .default("24h")
    .describe(
      "Maximum wait for a worker in this group, such as `24h` or `30m`; then the run is dead-lettered with `PLACEMENT_TIMEOUT`. Waiting consumes no execution attempt. `swizzle diagnose <runId>` says why a queued run waits.",
    ),
  timeout: z
    .string()
    .min(1)
    .default("60s")
    .describe(
      "Maximum run time such as `500ms`, `30s`, `5m` or `1h`. Deploy and the worker reject a value above `SWIZZLE_MAX_RUN_TIMEOUT` (default `1h`) unless a timeout grant raises the ceiling for this automation.",
    ),
  retry: retrySchema
    .default(retrySchema.parse({}))
    .describe("Retry policy for retryable failures."),
  rate_limits: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Named limits such as `60/min`. A worker takes one token per group before a run starts; SDK `pace(name)` spaces calls inside a run.",
    ),
  requirements: runtimeRequirementsSchema
    .default(runtimeRequirementsSchema.parse({}))
    .describe("Binaries and dependency manifests the run needs."),
  container: containerSchema.optional().describe("Container sandbox settings."),
});

export const runtimeConfigSchema = runtimeInputSchema.default(
  runtimeInputSchema.parse({ on_overlap: "queue" }),
);

// Installed artifacts retain the binary-rule grammar accepted by earlier 1.x releases.
const deployedRequirementsSchema = runtimeRequirementsSchema.extend({
  binaries: z
    .array(binaryRequirementSchema.extend({ version: z.string().min(1).optional() }))
    .default([]),
});
export const deployedRuntimeConfigSchema = runtimeInputSchema
  .extend({
    binary_version_matching: z.literal("numeric-prefix").optional(),
    requirements: deployedRequirementsSchema.default(deployedRequirementsSchema.parse({})),
  })
  .default(runtimeConfigSchema.parse(undefined));

const runtimeSchema = runtimeInputSchema.extend({
  language: runtimeInputSchema.shape.language.nonoptional(),
  on_overlap: runtimeInputSchema.shape.on_overlap.nonoptional(),
});

export const AUTOMATION_RETRY_DEFAULTS = retrySchema.parse({});

export type AutomationBinaryRequirement = z.output<typeof binaryRequirementSchema>;

export type AutomationPythonRequirements = z.output<typeof pythonDependencySchema>;

export type AutomationNodeRequirements = z.output<typeof nodeDependencySchema>;

export type AutomationRuntimeRequirements = z.output<typeof runtimeRequirementsSchema>;

export type AutomationRuntimePermissions = z.output<typeof runtimePermissionSchema>;

export type AutomationRuntimeConfig = z.output<typeof runtimeSchema> & {
  /** Absent in artifacts saved before numeric prefix matching was introduced. */
  readonly binary_version_matching?: "numeric-prefix";
};

export function inferAutomationLanguage(entrypoint: string): AutomationRuntimeConfig["language"] {
  const extension = path.extname(entrypoint).toLowerCase();

  switch (extension) {
    case ".js":
      return "node";
    case ".ts":
      return "typescript";
    default:
      return "python";
  }
}

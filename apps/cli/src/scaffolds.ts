import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AUTOMATION_ENV_NAME_PATTERN,
  type AutomationConfigInput,
  stringifyAutomationConfig,
} from "@swizzle/config";
import { SAMPLE_PAYLOAD_FILE_NAME } from "@swizzle/runtime";
import { AgentError, EXIT_CODES } from "./output.js";
import { resolveCliAssetDirectory } from "./package-assets.js";

export const INIT_TEMPLATE_IDS = ["python", "node", "typescript"] as const;
export const SCAFFOLD_PATTERN_IDS = [
  "webhook-basic",
  "webhook-transformer",
  "document-scanner",
  "cron-indexer",
] as const;

export type InitTemplateId = (typeof INIT_TEMPLATE_IDS)[number];
export type ScaffoldPatternId = (typeof SCAFFOLD_PATTERN_IDS)[number];

interface ScaffoldTemplateDefinition {
  readonly defaultPatternId: ScaffoldPatternId;
  readonly description: string;
  readonly displayName: string;
  readonly entrypoint: string;
  /** The API check stub beside the entrypoint, the file `api_check.mode: active` runs by default. */
  readonly checkFile: string;
  readonly generatedFiles: readonly string[];
  readonly helperStyle: "raw" | "vendored-sdk";
  readonly id: InitTemplateId;
  readonly runtime: "javascript" | "python" | "typescript";
  readonly runtimeCommand: "node" | "python3";
  readonly useCases: readonly string[];
}

interface ScaffoldPatternDefinition {
  readonly description: string;
  readonly displayName: string;
  readonly exampleIds: readonly string[];
  readonly id: ScaffoldPatternId;
  readonly recommendedTemplateId: InitTemplateId;
  readonly supportedTemplateIds: readonly InitTemplateId[];
  readonly trigger:
    | { readonly type: "cron"; readonly schedule: string }
    | { readonly type: "webhook" };
  readonly useCases: readonly string[];
}

type TriggerInput = AutomationConfigInput["trigger"];
type WebhookTriggerInput = Extract<TriggerInput, { type: "webhook" }>;

/**
 * The trigger a scaffold writes to config.yaml, as the schema takes it. A webhook gets a path with
 * 96 random bits and a signature, so a deployed one starts runs only for senders that sign the raw
 * body with its secret.
 */
export type ScaffoldTrigger =
  | Extract<TriggerInput, { type: "cron" }>
  | (WebhookTriggerInput & {
      readonly path: string;
      readonly signature: NonNullable<WebhookTriggerInput["signature"]>;
    });

/** The header and prefix a scaffolded webhook's senders put its signature in. */
const SCAFFOLD_SIGNATURE_HEADER = "x-swizzle-signature";
const SCAFFOLD_SIGNATURE_PREFIX = "sha256=";

export interface ResolvedScaffoldSelection {
  readonly pattern: ScaffoldPatternId;
  readonly template: InitTemplateId;
}

export interface ScaffoldFile {
  readonly content: string;
  readonly filePath: string;
}

export interface SerializableScaffoldCatalog {
  readonly defaults: {
    readonly pattern: ScaffoldPatternId;
    readonly template: InitTemplateId;
  };
  readonly patterns: readonly ScaffoldPatternDefinition[];
  readonly templates: readonly ScaffoldTemplateDefinition[];
  readonly version: 1;
}

const TEMPLATE_DEFINITIONS: Record<InitTemplateId, ScaffoldTemplateDefinition> = {
  node: {
    defaultPatternId: "webhook-basic",
    description:
      "Low-friction plain Node.js scaffold that stays close to the raw stdin/stdout contract.",
    displayName: "Node.js",
    entrypoint: "main.js",
    checkFile: "check.js",
    generatedFiles: [
      "README.md",
      "check.js",
      "config.yaml",
      "flow.mermaid",
      "main.js",
      "package.json",
      SAMPLE_PAYLOAD_FILE_NAME,
    ],
    helperStyle: "raw",
    id: "node",
    runtime: "javascript",
    runtimeCommand: "node",
    useCases: ["partner webhooks", "small event normalizers", "minimal JavaScript automation"],
  },
  python: {
    defaultPatternId: "webhook-basic",
    description:
      "Python scaffold with a vendored helper for payload parsing, runtime metadata, and stderr step logs.",
    displayName: "Python",
    entrypoint: "main.py",
    checkFile: "check.py",
    generatedFiles: [
      "README.md",
      "swizzle_sdk.py",
      "check.py",
      "config.yaml",
      "flow.mermaid",
      "main.py",
      SAMPLE_PAYLOAD_FILE_NAME,
    ],
    helperStyle: "vendored-sdk",
    id: "python",
    runtime: "python",
    runtimeCommand: "python3",
    useCases: ["text processing", "document workflows", "standard-library-friendly automation"],
  },
  typescript: {
    defaultPatternId: "webhook-basic",
    description:
      "TypeScript scaffold with a vendored helper for typed payload handling, runtime metadata, and structured step logs.",
    displayName: "TypeScript",
    entrypoint: "main.ts",
    checkFile: "check.ts",
    generatedFiles: [
      "README.md",
      "swizzle-sdk.ts",
      "check.ts",
      "config.yaml",
      "flow.mermaid",
      "main.ts",
      "package.json",
      SAMPLE_PAYLOAD_FILE_NAME,
    ],
    helperStyle: "vendored-sdk",
    id: "typescript",
    runtime: "typescript",
    runtimeCommand: "node",
    useCases: ["agent-generated automations", "typed webhook handling", "richer automation logic"],
  },
};

const PATTERN_DEFINITIONS: Record<ScaffoldPatternId, ScaffoldPatternDefinition> = {
  "cron-indexer": {
    description:
      "Dry-run-friendly indexing scaffold for scheduled jobs that chunk documents and return an index plan.",
    displayName: "Cron indexer",
    exampleIds: ["rag-indexer"],
    id: "cron-indexer",
    recommendedTemplateId: "python",
    supportedTemplateIds: ["python", "typescript"],
    trigger: {
      schedule: "0 * * * *",
      type: "cron",
    },
    useCases: ["scheduled indexing", "batch content processing", "recurring maintenance jobs"],
  },
  "document-scanner": {
    description:
      "Webhook scaffold for turning raw document text into a structured summary without external services.",
    displayName: "Document scanner",
    exampleIds: ["document-scanner"],
    id: "document-scanner",
    recommendedTemplateId: "python",
    supportedTemplateIds: ["python"],
    trigger: { type: "webhook" },
    useCases: ["document intake", "text extraction", "lightweight content classification"],
  },
  "webhook-basic": {
    description: "Smallest believable happy-path webhook automation scaffold.",
    displayName: "Webhook basic",
    exampleIds: ["hello-webhook"],
    id: "webhook-basic",
    recommendedTemplateId: "python",
    supportedTemplateIds: ["python", "node", "typescript"],
    trigger: { type: "webhook" },
    useCases: ["hello world", "runtime smoke test", "simple inbound webhooks"],
  },
  "webhook-transformer": {
    description:
      "Webhook scaffold for normalizing inconsistent third-party payloads into one internal event envelope.",
    displayName: "Webhook transformer",
    exampleIds: ["webhook-transformer", "typescript-webhook"],
    id: "webhook-transformer",
    recommendedTemplateId: "node",
    supportedTemplateIds: ["node", "typescript"],
    trigger: { type: "webhook" },
    useCases: ["partner integrations", "schema normalization", "event envelope translation"],
  },
};

export function createAutomationSlug(directoryName: string): string {
  const normalized = directoryName
    .trim()
    .replaceAll(/\s+/g, "-")
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");

  return normalized.length > 0 ? normalized : "my-automation";
}

export function createScaffoldTrigger(
  selection: ResolvedScaffoldSelection,
  automationName: string,
): ScaffoldTrigger {
  const trigger = PATTERN_DEFINITIONS[selection.pattern].trigger;
  if (trigger.type === "cron") return { type: "cron", schedule: trigger.schedule };
  const stem = automationName
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/g, "_")
    .replaceAll(/^_|_$/g, "");
  const secret = `${stem}_SIGNING_SECRET`;
  return {
    type: "webhook",
    path: `/hooks/${automationName}-${randomBytes(12).toString("hex")}`,
    signature: {
      // An automation name may start with a digit, which a secret name may not.
      secret: AUTOMATION_ENV_NAME_PATTERN.test(secret) ? secret : `HOOK_${secret}`,
      header: SCAFFOLD_SIGNATURE_HEADER,
      prefix: SCAFFOLD_SIGNATURE_PREFIX,
    },
  };
}

/**
 * The commands that make a webhook's signing key and store it as `secret`. They run before
 * `swizzle validate`, which refuses a version whose secret the instance lacks; the scaffold's
 * README.md and the answer of `swizzle init` list them in that order.
 */
export function signingKeyCommands(secret: string): readonly [string, string] {
  return [
    `export ${secret}="$(openssl rand -hex 32)"`,
    `swizzle secret set ${secret} --value-env ${secret}`,
  ];
}

export function getSerializableScaffoldCatalog(): SerializableScaffoldCatalog {
  return {
    defaults: {
      pattern: "webhook-basic",
      template: "python",
    },
    patterns: SCAFFOLD_PATTERN_IDS.map((id) => PATTERN_DEFINITIONS[id]),
    templates: INIT_TEMPLATE_IDS.map((id) => TEMPLATE_DEFINITIONS[id]),
    version: 1,
  };
}

export function templateCheckFile(template: InitTemplateId): string {
  return TEMPLATE_DEFINITIONS[template].checkFile;
}

export function resolveScaffoldSelection(input: {
  readonly pattern?: ScaffoldPatternId;
  readonly template?: InitTemplateId;
}): ResolvedScaffoldSelection {
  const pattern = input.pattern ?? "webhook-basic";
  const patternDefinition = PATTERN_DEFINITIONS[pattern];
  const template = input.template ?? patternDefinition.recommendedTemplateId;

  if (!patternDefinition.supportedTemplateIds.includes(template)) {
    throw new AgentError({
      code: "SCAFFOLD_TEMPLATE_UNSUPPORTED",
      exitCode: EXIT_CODES.usage,
      hint: `Pass --template ${patternDefinition.supportedTemplateIds.join(" or --template ")}, or drop --template for the pattern's default.`,
      message: `Pattern "${pattern}" does not support template "${template}".`,
    });
  }

  return {
    pattern,
    template,
  };
}

export async function buildTemplateFiles(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
  readonly targetDirectory: string;
  readonly trigger: ScaffoldTrigger;
}): Promise<readonly ScaffoldFile[]> {
  const sharedFiles: ScaffoldFile[] = [
    {
      content: buildConfigYaml(input),
      filePath: `${input.targetDirectory}/config.yaml`,
    },
    {
      content: buildReadme(input),
      filePath: `${input.targetDirectory}/README.md`,
    },
    {
      content: buildFlowDiagram(input),
      filePath: `${input.targetDirectory}/flow.mermaid`,
    },
    {
      content: buildSamplePayload(input),
      filePath: `${input.targetDirectory}/${SAMPLE_PAYLOAD_FILE_NAME}`,
    },
  ];
  const packageJsonFiles =
    input.selection.template === "python"
      ? []
      : [
          {
            content: buildPackageJson(input),
            filePath: `${input.targetDirectory}/package.json`,
          } satisfies ScaffoldFile,
        ];

  const entrypointFiles = await buildEntrypointFiles(input);
  return [...sharedFiles, ...packageJsonFiles, ...entrypointFiles];
}

async function buildEntrypointFiles(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
  readonly targetDirectory: string;
}): Promise<readonly ScaffoldFile[]> {
  switch (input.selection.template) {
    case "python":
      return [
        {
          content: await readVendoredSdkAsset("swizzle_sdk.py"),
          filePath: `${input.targetDirectory}/swizzle_sdk.py`,
        },
        {
          content: buildPythonEntrypoint(input),
          filePath: `${input.targetDirectory}/main.py`,
        },
        { content: PYTHON_CHECK_STUB, filePath: `${input.targetDirectory}/check.py` },
      ];
    case "node":
      return [
        {
          content: buildNodeEntrypoint(input),
          filePath: `${input.targetDirectory}/main.js`,
        },
        { content: NODE_CHECK_STUB, filePath: `${input.targetDirectory}/check.js` },
      ];
    case "typescript":
      return [
        {
          content: await readVendoredSdkAsset("swizzle-sdk.ts"),
          filePath: `${input.targetDirectory}/swizzle-sdk.ts`,
        },
        {
          content: buildTypeScriptEntrypoint(input),
          filePath: `${input.targetDirectory}/main.ts`,
        },
        { content: TYPESCRIPT_CHECK_STUB, filePath: `${input.targetDirectory}/check.ts` },
      ];
  }
}

// The API check stubs. A fresh scaffold calls no API, so its config.yaml has no api_check; the
// schema asks for the decision once the automation lists a secret or a connection. Each stub
// exits 1 with a todo, so switching to `mode: active` before writing the check shows an API check
// warning instead of a false green.
const CHECK_RULES = [
  "API check. With `api_check: { mode: active }` in config.yaml, Swizzle runs this file every 7d",
  "and after each deploy. A check is never a run: it reads the payload {}, holds no state, and",
  "draws from the automation's rate_limits.",
  "",
  "Keep it read-only: one cheap GET per API the automation calls. The platform cannot enforce",
  "that, because a check holds the same secrets as a run. Where the API offers a read-only key,",
  "give the check only that key with api_check.secrets.",
  "",
  "Parse the answer with the same function the entrypoint uses, so a changed API fails here and",
  'in the next run on the same field. Exit 0 and print {"ok": true, "checked": [...]} when the',
  "answer matches. Exit 1 when it does not (drift). Any other ending counts as undecided, such as",
  "a 503, and shows after 3 in a row.",
];

const TYPESCRIPT_CHECK_STUB = `${CHECK_RULES.map((line) => `// ${line}`.trimEnd()).join("\n")}
//
// Calls through apiFetch let the platform see the API's Deprecation and Sunset headers, and
// contractChanged prints the drift result and exits 1. Keep the parser in a module that main.ts
// and this file both import, such as parse.ts, because importing main.ts would run it:
//
//   import { apiFetch, contractChanged } from "./swizzle-sdk.ts";
//   import { parseItems } from "./parse.ts";
//
//   const response = await apiFetch("https://api.example.com/v1/items?limit=1", {
//     headers: { authorization: \`Bearer \${process.env.EXAMPLE_API_KEY}\` },
//   });
//   const parsed = parseItems(await response.json());
//   if (!parsed.ok) contractChanged({ api: "api.example.com", ...parsed.mismatch });
//   console.log(JSON.stringify({ ok: true, checked: ["GET /v1/items?limit=1"] }));

console.error("check.ts is a stub: replace it with a read-only check of the API this automation calls.");
console.log(JSON.stringify({ ok: false, todo: "write the API check in check.ts" }));
process.exit(1);
`;

const PYTHON_CHECK_STUB = `#!/usr/bin/env python3
${CHECK_RULES.map((line) => `# ${line}`.trimEnd()).join("\n")}
#
# Calls through api_request let the platform see the API's Deprecation and Sunset headers, and
# contract_changed prints the drift result and exits 1. Keep the parser in a module that main.py
# and this file both import, such as parse.py, because importing main.py would run it:
#
#   import os
#   from swizzle_sdk import api_request, contract_changed
#   from parse import parse_items
#
#   response = api_request(
#       "https://api.example.com/v1/items?limit=1",
#       headers={"authorization": f"Bearer {os.environ['EXAMPLE_API_KEY']}"},
#   )
#   mismatch = parse_items(response.json()).mismatch
#   if mismatch is not None:
#       contract_changed("api.example.com", mismatch.field, mismatch.expected, mismatch.got)
#   print(json.dumps({"ok": True, "checked": ["GET /v1/items?limit=1"]}))
import json
import sys

print("check.py is a stub: replace it with a read-only check of the API this automation calls.", file=sys.stderr)
print(json.dumps({"ok": False, "todo": "write the API check in check.py"}))
sys.exit(1)
`;

const NODE_CHECK_STUB = `#!/usr/bin/env node
${CHECK_RULES.map((line) => `// ${line}`.trimEnd()).join("\n")}
//
// This template uses no SDK. On a mismatch, print the field to stderr as one JSON line, then the
// result to stdout, and exit 1:
//
//   process.stderr.write(JSON.stringify({ type: "contract_changed", api: "api.example.com",
//     field: "items[].amount", expected: "a number", got: "a string" }) + "\\n");
//   console.log(JSON.stringify({ ok: false, api: "api.example.com", field: "items[].amount" }));
//   process.exit(1);

console.error("check.js is a stub: replace it with a read-only check of the API this automation calls.");
console.log(JSON.stringify({ ok: false, todo: "write the API check in check.js" }));
process.exit(1);
`;

async function readVendoredSdkAsset(fileName: string): Promise<string> {
  return await readFile(path.join(await resolveCliAssetDirectory("sdk"), fileName), "utf8");
}

function buildConfigYaml(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
  readonly trigger: ScaffoldTrigger;
}): string {
  const template = TEMPLATE_DEFINITIONS[input.selection.template];
  return stringifyAutomationConfig({
    name: input.automationName,
    version: "1.0.0",
    description: buildConfigDescription(input.selection),
    entrypoint: template.entrypoint,
    trigger: input.trigger,
    runtime: {
      language: template.runtime === "javascript" ? "node" : template.runtime,
      execution_mode: "host",
      profile: "host-default",
      timeout: "30s",
      permissions: { network: true, writable_dirs: [] },
      retry: { max_attempts: 3, backoff: "exponential" },
      requirements: { binaries: [] },
    },
    secrets: [],
  });
}

function buildPackageJson(input: { readonly automationName: string }): string {
  return `${JSON.stringify(
    {
      name: input.automationName,
      private: true,
      type: "module",
      version: "1.0.0",
    },
    null,
    2,
  )}\n`;
}

function buildConfigDescription(selection: ResolvedScaffoldSelection): string {
  switch (selection.pattern) {
    case "webhook-basic":
      return selection.template === "python"
        ? "Python webhook automation scaffold for Swizzle"
        : selection.template === "node"
          ? "Node.js webhook automation scaffold for Swizzle"
          : "TypeScript webhook automation scaffold for Swizzle";
    case "webhook-transformer":
      return selection.template === "node"
        ? "Node.js webhook transformer scaffold for Swizzle"
        : "TypeScript webhook transformer scaffold for Swizzle";
    case "document-scanner":
      return "Python document scanner scaffold for Swizzle";
    case "cron-indexer":
      return selection.template === "typescript"
        ? "TypeScript cron indexer scaffold for Swizzle"
        : "Python cron indexer scaffold for Swizzle";
  }
}

function buildReadme(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
  readonly trigger: ScaffoldTrigger;
}): string {
  const template = TEMPLATE_DEFINITIONS[input.selection.template];
  const pattern = PATTERN_DEFINITIONS[input.selection.pattern];
  const { trigger } = input;

  return [
    `# ${input.automationName}`,
    "",
    `${template.displayName} scaffold for the ${pattern.displayName.toLowerCase()} pattern.`,
    "",
    "## What it demonstrates",
    "",
    `- ${pattern.description}`,
    `- ${template.helperStyle === "vendored-sdk" ? "Vendored Swizzle helper for payload parsing, runtime metadata, and stderr step logging" : "Raw stdin/stdout runtime contract without an extra helper layer"}`,
    `- Local execution with ${template.runtimeCommand}`,
    "",
    "## Workflow",
    "",
    "```bash",
    "swizzle run .",
    `swizzle run . --payload-file ${SAMPLE_PAYLOAD_FILE_NAME}`,
    ...(trigger.type === "webhook" ? signingKeyCommands(trigger.signature.secret) : []),
    "swizzle validate .",
    "swizzle apply .",
    "```",
    "",
    `The default \`swizzle run .\` command automatically uses \`${SAMPLE_PAYLOAD_FILE_NAME}\` when that file is present. \`swizzle run\` runs on this machine; \`swizzle validate\` and \`swizzle apply\` check against and deploy to the instance of your CLI profile.`,
    "",
    "## API check",
    "",
    `Once the automation lists a secret or a connection, config.yaml must say how its API is checked: \`api_check: { mode: active }\` runs \`${template.checkFile}\` every 7d and after each deploy, \`mode: passive\` adds no calls and learns only from real runs, and \`mode: off\` needs a reason, such as paid per call. \`${template.checkFile}\` is a stub that fails until you write a read-only check; try it with \`swizzle run --check .\`.`,
    ...(input.selection.template === "typescript"
      ? [
          "",
          "Node runs `main.ts` itself by stripping its types, as an ES module, so top-level `await` works. Write erasable TypeScript, without `enum`, `namespace` or constructor parameter properties, and import local files with their `.ts` extension.",
        ]
      : []),
    ...(trigger.type === "cron"
      ? [
          "",
          "Even though the configured trigger is cron, local `swizzle run .` still works with a JSON payload for development.",
        ]
      : [
          "",
          "## Webhook security",
          "",
          `The path \`${trigger.path}\` ends in a random token, so treat the webhook URL as a secret. A deployed webhook starts a run only for a request whose \`${SCAFFOLD_SIGNATURE_HEADER}\` header holds \`${SCAFFOLD_SIGNATURE_PREFIX}\` and the hex HMAC-SHA256 of the raw body, keyed with the secret \`${trigger.signature.secret}\`. Any other request gets the same 404 as an unknown path. The workflow above sets the key before \`swizzle validate\`, which refuses a version whose secret the instance does not have yet.`,
          "",
          "Give the same key to the sender. A signed test request:",
          "",
          "```bash",
          `body="$(cat ${SAMPLE_PAYLOAD_FILE_NAME})"`,
          `signature="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$${trigger.signature.secret}" -r | cut -d' ' -f1)"`,
          `curl -X POST "<webhookUrl from swizzle apply>" -H 'content-type: application/json' -H "${SCAFFOLD_SIGNATURE_HEADER}: ${SCAFFOLD_SIGNATURE_PREFIX}$signature" --data-binary "$body"`,
          "```",
          "",
          "A run started by hand, with `swizzle trigger`, Run now or a local `swizzle run`, skips this check. Its trigger type is `manual` instead of `webhook`, and it carries no sender headers, so code that acts on the sender's word checks for `webhook` first, as `signed_delivery` in the entrypoint does.",
          "",
          "A sender that cannot sign the raw body needs another check; see the webhook security reference of the swizzle-builder skill before you remove `signature`.",
        ]),
    "",
  ].join("\n");
}

function buildFlowDiagram(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
}): string {
  switch (input.selection.pattern) {
    case "webhook-basic":
      return [
        "flowchart TD",
        "  A[Webhook payload] --> B[main entrypoint]",
        `  B --> C[${input.automationName} result JSON]`,
        "",
      ].join("\n");
    case "webhook-transformer":
      return [
        "flowchart TD",
        "  A[Partner webhook] --> B[Normalize external fields]",
        `  B --> C[${input.automationName} internal event envelope]`,
        "",
      ].join("\n");
    case "document-scanner":
      return [
        "flowchart TD",
        "  A[Raw document text] --> B[Topic scan + summary extraction]",
        `  B --> C[${input.automationName} structured document JSON]`,
        "",
      ].join("\n");
    case "cron-indexer":
      return [
        "flowchart TD",
        "  A[Cron schedule] --> B[Chunk incoming documents]",
        `  B --> C[${input.automationName} index plan JSON]`,
        "",
      ].join("\n");
  }
}

function buildSamplePayload(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
}): string {
  switch (input.selection.pattern) {
    case "webhook-basic":
      // Neutral placeholder payload — replace with a realistic shape for your
      // trigger. `swizzle run .` uses this when sample-payload.json is present.
      return `${JSON.stringify(
        {
          _note: `Replace this with a realistic payload for ${input.automationName}.`,
          event: "example.created",
          source: input.automationName,
          data: {
            id: "example-id",
          },
        },
        null,
        2,
      )}\n`;
    case "webhook-transformer":
      return `${JSON.stringify(
        {
          customer: {
            email: "ops@example.com",
            id: "cust-123",
          },
          event: "invoice.created",
          occurred_at: "2026-04-14T10:00:00.000Z",
          payload_version: 3,
          source: "partner-platform",
        },
        null,
        2,
      )}\n`;
    case "document-scanner":
      return `${JSON.stringify(
        {
          content:
            "Invoice INV-2026-14 for ACME GmbH. Amount due EUR 482.10 before 2026-04-30. Billing contact: finance@acme.test",
          document_id: "doc-1001",
          mime_type: "text/plain",
          source: input.automationName,
        },
        null,
        2,
      )}\n`;
    case "cron-indexer":
      return `${JSON.stringify(
        {
          documents: [
            {
              content:
                "Swizzle stores deployments durably, materializes cron triggers, and keeps retries explicit for operators.",
              document_id: "doc-1",
              title: "runtime-overview",
            },
            {
              content:
                "The CLI scaffolds automations from a template catalog and prints machine-readable contracts for agents.",
              document_id: "doc-2",
              title: "authoring-notes",
            },
          ],
          source: input.automationName,
        },
        null,
        2,
      )}\n`;
  }
}

function buildPythonEntrypoint(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
}): string {
  switch (input.selection.pattern) {
    case "webhook-basic":
      return `#!/usr/bin/env python3\nfrom typing import Any\n\nfrom swizzle_sdk import AutomationContext, run_automation\n\n\ndef handle(context: AutomationContext) -> dict[str, Any]:\n    context.log_step(\n        "received webhook payload",\n        {"keys": sorted(context.payload.keys()) if isinstance(context.payload, dict) else []},\n    )\n\n    return {\n        "status": "ok",\n        "automation": "${input.automationName}",\n        "message": "Python scaffold executed successfully",\n        "payload": context.payload,\n        "run_id": context.metadata.run_id,\n        # Only a delivery passed the signature check; a run started by hand reads as "manual".\n        "signed_delivery": context.metadata.trigger_type == "webhook",\n        "trigger_type": context.metadata.trigger_type,\n    }\n\n\ndef main() -> int:\n    return run_automation(handle)\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n`;
    case "document-scanner":
      return `#!/usr/bin/env python3\nimport re\nfrom typing import Any\n\nfrom swizzle_sdk import AutomationContext, run_automation\n\nKEYWORDS = {\n    "invoice": ["invoice", "amount due", "billing"],\n    "contract": ["agreement", "term", "renewal"],\n    "support": ["ticket", "incident", "severity"],\n}\n\n\ndef summarize_document(payload: dict[str, Any]) -> dict[str, Any]:\n    content = str(payload.get("content", "")).strip()\n    normalized = re.sub(r"\\s+", " ", content)\n    lower_content = normalized.lower()\n    matches = [\n        label\n        for label, patterns in KEYWORDS.items()\n        if any(pattern in lower_content for pattern in patterns)\n    ]\n\n    return {\n        "document_id": payload.get("document_id"),\n        "mime_type": payload.get("mime_type", "text/plain"),\n        "preview": normalized[:140],\n        "word_count": len([word for word in normalized.split(" ") if word]),\n        "detected_topics": matches,\n        "requires_human_review": len(matches) == 0,\n    }\n\n\ndef handle(context: AutomationContext) -> dict[str, Any]:\n    if isinstance(context.payload, dict):\n        context.log_step("scanning document", {"document_id": context.payload.get("document_id")})\n\n    payload = context.payload if isinstance(context.payload, dict) else {}\n    return {\n        "status": "ok",\n        "mode": "local-demo",\n        "scan": summarize_document(payload),\n    }\n\n\ndef main() -> int:\n    return run_automation(handle)\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n`;
    case "cron-indexer":
      return `#!/usr/bin/env python3\nfrom typing import Any\n\nfrom swizzle_sdk import AutomationContext, run_automation\n\nCHUNK_SIZE = 80\n\n\ndef chunk_text(text: str) -> list[str]:\n    words = [word for word in text.split() if word]\n    if not words:\n        return []\n\n    chunks: list[str] = []\n    for start in range(0, len(words), CHUNK_SIZE):\n        chunks.append(" ".join(words[start : start + CHUNK_SIZE]))\n    return chunks\n\n\ndef build_index_plan(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:\n    plan: list[dict[str, Any]] = []\n    for document in documents:\n        chunks = chunk_text(str(document.get("content", "")))\n        plan.append(\n            {\n                "chunk_count": len(chunks),\n                "document_id": document.get("document_id"),\n                "preview": chunks[0][:120] if chunks else "",\n                "title": document.get("title"),\n            }\n        )\n    return plan\n\n\ndef handle(context: AutomationContext) -> dict[str, Any]:\n    payload = context.payload if isinstance(context.payload, dict) else {}\n    documents = payload.get("documents", []) if isinstance(payload.get("documents", []), list) else []\n    context.log_step("building index plan", {"documents_received": len(documents)})\n\n    return {\n        "status": "ok",\n        "dry_run": True,\n        "documents_received": len(documents),\n        "index_plan": build_index_plan(documents),\n        "next_step": "Send chunks to your real embedding/vector backend in a later phase.",\n    }\n\n\ndef main() -> int:\n    return run_automation(handle)\n\n\nif __name__ == "__main__":\n    raise SystemExit(main())\n`;
    case "webhook-transformer":
      throw new Error('Pattern "webhook-transformer" does not support template "python".');
  }
}

function buildNodeEntrypoint(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
}): string {
  switch (input.selection.pattern) {
    case "webhook-basic":
      return `#!/usr/bin/env node\nconst chunks = [];\n\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => chunks.push(chunk));\nprocess.stdin.on("end", () => {\n  const raw = chunks.join("").trim();\n  const payload = raw.length === 0 ? {} : JSON.parse(raw);\n\n  const result = {\n    status: "ok",\n    automation: "${input.automationName}",\n    message: "Node scaffold executed successfully",\n    payload,\n    run_id: process.env.SWIZZLE_RUN_ID ?? null,\n    // Only a delivery passed the signature check; a run started by hand reads as "manual".\n    signed_delivery: process.env.SWIZZLE_TRIGGER_TYPE === "webhook",\n    trigger_type: process.env.SWIZZLE_TRIGGER_TYPE ?? null,\n  };\n\n  process.stdout.write(JSON.stringify(result));\n  process.stdout.write("\\n");\n});\n`;
    case "webhook-transformer":
      return `#!/usr/bin/env node\nconst chunks = [];\n\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (chunk) => chunks.push(chunk));\nprocess.stdin.on("end", () => {\n  const raw = chunks.join("").trim();\n  const payload = raw.length === 0 ? {} : JSON.parse(raw);\n\n  const normalized = {\n    event: payload.event ?? payload.type ?? "unknown",\n    occurred_at: payload.occurred_at ?? new Date().toISOString(),\n    source: payload.source ?? payload.vendor ?? "unknown",\n    customer: {\n      email: payload.customer?.email ?? payload.email ?? null,\n      id: payload.customer?.id ?? payload.customer_id ?? null,\n    },\n    meta: {\n      received_fields: Object.keys(payload).sort(),\n      schema_version: 1,\n    },\n    payload,\n  };\n\n  process.stdout.write(JSON.stringify({ status: "ok", normalized }));\n  process.stdout.write("\\n");\n});\n`;
    case "document-scanner":
    case "cron-indexer":
      throw new Error(`Pattern "${input.selection.pattern}" does not support template "node".`);
  }
}

function buildTypeScriptEntrypoint(input: {
  readonly automationName: string;
  readonly selection: ResolvedScaffoldSelection;
}): string {
  switch (input.selection.pattern) {
    case "webhook-basic":
      return `#!/usr/bin/env node\nimport { runAutomation } from "./swizzle-sdk.ts";\n\nawait runAutomation<Record<string, unknown>, Record<string, unknown>>(async ({ payload, metadata, logStep }) => {\n  logStep("received webhook payload", { keys: Object.keys(payload).sort() });\n\n  return {\n    status: "ok",\n    automation: "${input.automationName}",\n    message: "TypeScript scaffold executed successfully",\n    payload,\n    run_id: metadata.runId,\n    // Only a delivery passed the signature check; a run started by hand reads as "manual".\n    signed_delivery: metadata.triggerType === "webhook",\n    trigger_type: metadata.triggerType,\n  };\n});\n`;
    case "webhook-transformer":
      return `#!/usr/bin/env node\nimport { runAutomation } from "./swizzle-sdk.ts";\n\ntype PartnerPayload = {\n  readonly customer?: {\n    readonly email?: string;\n    readonly id?: string;\n  };\n  readonly customer_id?: string;\n  readonly email?: string;\n  readonly event?: string;\n  readonly occurred_at?: string;\n  readonly source?: string;\n  readonly type?: string;\n  readonly vendor?: string;\n  readonly [key: string]: unknown;\n};\n\nawait runAutomation<PartnerPayload, Record<string, unknown>>(async ({ payload, logStep }) => {\n  logStep("normalizing partner webhook", { source: payload.source ?? payload.vendor ?? "unknown" });\n\n  return {\n    status: "ok",\n    normalized: {\n      customer: {\n        email: payload.customer?.email ?? payload.email ?? null,\n        id: payload.customer?.id ?? payload.customer_id ?? null,\n      },\n      event: payload.event ?? payload.type ?? "unknown",\n      meta: {\n        received_fields: Object.keys(payload).sort(),\n        schema_version: 1,\n      },\n      occurred_at: payload.occurred_at ?? new Date().toISOString(),\n      payload,\n      source: payload.source ?? payload.vendor ?? "unknown",\n    },\n  };\n});\n`;
    case "cron-indexer":
      return `#!/usr/bin/env node\nimport { runAutomation } from "./swizzle-sdk.ts";\n\ntype IndexDocument = {\n  readonly content?: string;\n  readonly document_id?: string;\n  readonly title?: string;\n};\n\ntype IndexPayload = {\n  readonly documents?: readonly IndexDocument[];\n};\n\nconst CHUNK_SIZE = 80;\n\nfunction chunkText(text: string): string[] {\n  const words = text.split(/\\s+/).filter(Boolean);\n  const chunks: string[] = [];\n\n  for (let start = 0; start < words.length; start += CHUNK_SIZE) {\n    chunks.push(words.slice(start, start + CHUNK_SIZE).join(" "));\n  }\n\n  return chunks;\n}\n\nawait runAutomation<IndexPayload, Record<string, unknown>>(async ({ payload, logStep }) => {\n  const documents = Array.isArray(payload.documents) ? payload.documents : [];\n  logStep("building index plan", { documents_received: documents.length });\n\n  return {\n    status: "ok",\n    dry_run: true,\n    documents_received: documents.length,\n    index_plan: documents.map((document) => {\n      const chunks = chunkText(String(document.content ?? ""));\n      return {\n        chunk_count: chunks.length,\n        document_id: document.document_id ?? null,\n        preview: chunks[0]?.slice(0, 120) ?? "",\n        title: document.title ?? null,\n      };\n    }),\n    next_step: "Send chunks to your real embedding/vector backend in a later phase.",\n  };\n});\n`;
    case "document-scanner":
      throw new Error('Pattern "document-scanner" does not support template "typescript".');
  }
}

import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  createAutomationConfigJsonSchema,
  inferAutomationLanguage,
  parseAutomationConfig,
} from "./schema.js";

describe("parseAutomationConfig", () => {
  it.each(["^25", "~25", "25.x", ">=25 <26", "v25", "garbage", "25."])(
    "rejects unsupported binary version rule %s with its accepted forms",
    (rule) => {
      expect(() =>
        parseAutomationConfig(`
name: pdf
version: 1.0.0
entrypoint: main.py
trigger: { type: webhook }
runtime:
  requirements:
    binaries:
      - name: pdftoppm
        version: "${rule}"
`),
      ).toThrow(/version.*Invalid.*>=.*<=.*>.*<.*=/);
    },
  );

  it("rejects unknown keys and names every offending path", () => {
    const parse = () =>
      parseAutomationConfig(`
name: typo
version: 1.0.0
trigger:
  type: cron
  shedule: "*/5 * * * *"
  every: 5m
runtme:
  timeout: 1s
`);

    expect(parse).toThrowError(/trigger\.shedule/);
    expect(parse).toThrowError(/runtme/);
  });

  it.each([
    ["runtime", "runtime:\n  workers: 2\n"],
    ["runtime.retry", "runtime:\n  retry:\n    max_attempt: 2\n"],
    ["runtime.permissions", "runtime:\n  permissions:\n    netwrk: false\n"],
    ["runtime.requirements", "runtime:\n  requirements:\n    binarys: []\n"],
    ["runtime.container", "runtime:\n  container:\n    cpu: '1'\n"],
    [
      "trigger.signature",
      "trigger:\n  type: webhook\n  signature:\n    header: x-sig\n    secret: S\n    prefx: sha\n",
    ],
    ["trigger", "trigger:\n  type: webhook\n  paths: /x\n"],
    ["trigger", "trigger:\n  type: chain\n  source: a\n  onn: failed\n"],
  ])("rejects an unknown key under %s", (keyPath, extra) => {
    const base = "name: n\nversion: 1.0.0\n";
    const yaml = extra.startsWith("trigger:")
      ? base + extra
      : `${base}trigger:\n  type: webhook\n${extra}`;
    expect(() => parseAutomationConfig(yaml)).toThrowError(
      new RegExp(keyPath.replaceAll(".", "\\.")),
    );
  });

  it("parses vars and preserves scalar values", () => {
    const config = parseAutomationConfig(`
name: tuned-automation
version: 1.0.0
trigger:
  type: webhook
secrets:
  - API_KEY
api_check:
  mode: passive
vars:
  FEATURE_MODE: dry-run
  MAX_ITEMS: 25
  ENABLE_CREATE: false
`);

    expect(config.vars).toEqual({
      ENABLE_CREATE: false,
      FEATURE_MODE: "dry-run",
      MAX_ITEMS: 25,
    });
  });

  it("rejects vars with invalid, reserved, or secret-colliding names", () => {
    expect(() =>
      parseAutomationConfig(`
name: bad-var-name
version: 1.0.0
trigger:
  type: webhook
vars:
  lower_case: nope
`),
    ).toThrowError(/uppercase env names/);

    expect(() =>
      parseAutomationConfig(`
name: reserved-var-name
version: 1.0.0
trigger:
  type: webhook
vars:
  SWIZZLE_RUN_ID: nope
`),
    ).toThrowError(/reserved/);

    expect(() =>
      parseAutomationConfig(`
name: colliding-var-name
version: 1.0.0
trigger:
  type: webhook
secrets:
  - API_KEY
vars:
  API_KEY: nope
`),
    ).toThrowError(/conflicts with a declared secret/);
  });

  it("rejects connection names that are not kebab-case", () => {
    expect(() =>
      parseAutomationConfig(`
name: drive-sync
version: 1.0.0
trigger:
  type: webhook
connections:
  - Google_Main
`),
    ).toThrowError(/kebab-case/);
  });

  it("normalizes webhook signature settings: lower-cased header, hmac-sha256 hex defaults", () => {
    const config = parseAutomationConfig(`
name: signed-webhook
version: 1.0.0
trigger:
  type: webhook
  path: /signed
  signature:
    secret: WEBHOOK_SIGNING_SECRET
    header: X-Swizzle-Signature
    prefix: sha256=
`);

    expect(config.trigger.type).toBe("webhook");
    if (config.trigger.type === "webhook") {
      expect(config.trigger.signature).toEqual({
        algorithm: "hmac-sha256",
        encoding: "hex",
        header: "x-swizzle-signature",
        prefix: "sha256=",
        secret: "WEBHOOK_SIGNING_SECRET",
      });
    }
  });

  it("rejects signature headers that carry platform credentials", () => {
    for (const header of ["authorization", "Proxy-Authorization", "Cookie"]) {
      expect(() =>
        parseAutomationConfig(`
name: stolen-token-webhook
version: 1.0.0
trigger:
  type: webhook
  path: /stolen
  signature:
    secret: WEBHOOK_SIGNING_SECRET
    header: ${header}
`),
      ).toThrow(/credential headers/);
    }
  });

  it("rejects signature headers that are not valid HTTP header names", () => {
    expect(() =>
      parseAutomationConfig(`
name: broken-header-webhook
version: 1.0.0
trigger:
  type: webhook
  path: /broken-header
  signature:
    secret: WEBHOOK_SIGNING_SECRET
    header: "x-signature: value"
`),
    ).toThrow(/valid HTTP header name/);
  });

  it("rejects invalid webhook payload schemas", () => {
    expect(() =>
      parseAutomationConfig(`
name: broken-webhook
version: 1.0.0
trigger:
  type: webhook
  path: /broken
  payload_schema:
    type: not-a-json-schema-type
`),
    ).toThrow(/trigger\.payload_schema must be a valid JSON Schema/);
  });

  it("parses multi-source chain triggers with all-succeeded results defaults", () => {
    const config = parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  sources:
    - reviewer
    - e2e-verifier
`);

    expect(config.trigger).toEqual({
      type: "chain",
      sources: ["reviewer", "e2e-verifier"],
      on: "all-succeeded",
      payload: "results",
    });
  });

  it("rejects invalid multi-source chain trigger shapes", () => {
    expect(() =>
      parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  source: reviewer
  sources:
    - reviewer
    - e2e-verifier
`),
    ).toThrowError(/exactly one of 'source' or 'sources'/);

    expect(() =>
      parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  sources:
    - reviewer
`),
    ).toThrowError(/requires at least 2 distinct sources/);

    expect(() =>
      parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  sources:
    - reviewer
    - reviewer
`),
    ).toThrowError(/requires at least 2 distinct sources/);

    // Uniqueness must hold on normalized slugs — deployment resolves
    // "Review Bot" and "review-bot" to the same automation.
    expect(() =>
      parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  sources:
    - Review Bot
    - review-bot
`),
    ).toThrowError(/requires at least 2 distinct sources/);

    expect(() =>
      parseAutomationConfig(`
name: review-bot
version: 1.0.0
trigger:
  type: chain
  sources:
    - Review Bot
    - e2e-verifier
`),
    ).toThrowError(/must not include the automation itself/);

    expect(() =>
      parseAutomationConfig(`
name: reviewer
version: 1.0.0
trigger:
  type: chain
  sources:
    - reviewer
    - e2e-verifier
`),
    ).toThrowError(/must not include the automation itself/);
  });

  it("restricts chain on and payload modes by source shape", () => {
    expect(() =>
      parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  sources:
    - reviewer
    - e2e-verifier
  on: succeeded
`),
    ).toThrowError(/requires on: all-succeeded/);

    expect(() =>
      parseAutomationConfig(`
name: joiner
version: 1.0.0
trigger:
  type: chain
  sources:
    - reviewer
    - e2e-verifier
  payload: full
`),
    ).toThrowError(/requires payload: results/);

    expect(() =>
      parseAutomationConfig(`
name: single-chain
version: 1.0.0
trigger:
  type: chain
  source: reviewer
  on: all-succeeded
`),
    ).toThrowError(/requires on: succeeded, failed, dead-lettered, or finished/);

    expect(() =>
      parseAutomationConfig(`
name: single-chain
version: 1.0.0
trigger:
  type: chain
  source: reviewer
  payload: results
`),
    ).toThrowError(/requires payload: result, payload, or full/);
  });

  it("exports a JSON schema that accepts the minimal config the parser accepts", () => {
    const minimal = { name: "hello", trigger: { type: "chain", source: "upstream" }, version: "1" };
    const validate = new Ajv2020({ strict: false }).compile(createAutomationConfigJsonSchema());

    expect(parseAutomationConfig(JSON.stringify(minimal)).name).toBe("hello");
    expect(validate(minimal), JSON.stringify(validate.errors)).toBe(true);
  });

  it("infers runtime language from the entrypoint when omitted", () => {
    expect(inferAutomationLanguage("main.py")).toBe("python");
    expect(inferAutomationLanguage("src/index.js")).toBe("node");
    expect(inferAutomationLanguage("src/main.ts")).toBe("typescript");
  });

  it("rejects dependency and writable paths that escape the automation sandbox", () => {
    expect(() =>
      parseAutomationConfig(`
name: traversal
version: 1.0.0
entrypoint: main.py
trigger:
  type: webhook
runtime:
  permissions:
    writable_dirs: ["../../host"]
  requirements:
    python:
      requirements_file: ../../etc/passwd
`),
    ).toThrow(/cannot traverse parents|must stay inside the automation bundle/u);

    expect(() =>
      parseAutomationConfig(`
name: mount-options
version: 1.0.0
entrypoint: main.py
trigger:
  type: webhook
runtime:
  permissions:
    writable_dirs: ["/work:exec,size=1g"]
`),
    ).toThrow(/mount-option delimiters/u);
  });

  it("rejects a writable directory that starts with ~, because the sandbox does not expand it", () => {
    expect(() =>
      parseAutomationConfig(`
name: tilde
version: 1.0.0
entrypoint: main.py
trigger:
  type: webhook
runtime:
  permissions:
    writable_dirs: ["~/data"]
`),
    ).toThrow(
      'runtime.permissions.writable_dirs.0: Writable directory "~/data" starts with "~", which is not expanded.',
    );
  });
});

describe("api_check", () => {
  const withSecret = (apiCheck: string) => `
name: invoice-sync
version: 1.0.0
entrypoint: main.ts
trigger:
  type: cron
  every: 1h
secrets: [LEXOFFICE_API_KEY]
${apiCheck}`;

  it("requires the decision from an automation with an outside secret and names the three modes", () => {
    expect(() => parseAutomationConfig(withSecret(""))).toThrow(
      /^api_check: uses secret LEXOFFICE_API_KEY, so config\.yaml must say how its API is checked\..*mode active .*mode passive .*mode off with a reason/u,
    );
  });

  it("does not count the webhook signing secret as an outside API", () => {
    const config = parseAutomationConfig(`
name: signed-webhook
version: 1.0.0
trigger:
  type: webhook
  signature:
    header: x-sig
    secret: WEBHOOK_SIGNING_SECRET
secrets: [WEBHOOK_SIGNING_SECRET]
`);

    expect(config.api_check).toBeUndefined();
  });

  it("fills the active defaults: check.ts beside the entrypoint, every 7d", () => {
    expect(parseAutomationConfig(withSecret("api_check:\n  mode: active\n")).api_check).toEqual({
      entrypoint: "check.ts",
      every: "7d",
      mode: "active",
    });
  });

  it("refuses off without a reason, a check secret the automation does not list, and checks more often than hourly", () => {
    for (const off of ["api_check:\n  mode: off\n", "api_check:\n  mode: off\n  reason: ' '\n"]) {
      expect(() => parseAutomationConfig(withSecret(off))).toThrow(
        "api_check.reason: mode off needs a reason, for example: paid per call.",
      );
    }
    expect(() =>
      parseAutomationConfig(withSecret("api_check:\n  mode: active\n  secrets: [OTHER_KEY]\n")),
    ).toThrow(/OTHER_KEY/u);
    expect(() =>
      parseAutomationConfig(withSecret("api_check:\n  mode: active\n  every: 5m\n")),
    ).toThrow(/api_check\.every/u);
  });
});

describe("runtime normalization contract", () => {
  it("keeps omitted runtime defaults distinct from an explicitly empty cron runtime", () => {
    const config =
      "name: demo\nversion: 1.0.0\nentrypoint: main.ts\ntrigger:\n  type: cron\n  schedule: '* * * * *'\n";
    expect(parseAutomationConfig(config).runtime).toMatchObject({
      language: "typescript",
      on_overlap: "queue",
      execution_mode: "host",
      permissions: { network: true, services: [], writable_dirs: [] },
      requirements: { binaries: [] },
      retry: { max_attempts: 3, backoff: "exponential" },
      timeout: "60s",
      queue_timeout: "24h",
      profile: "host-default",
      rate_limits: {},
    });
    expect(parseAutomationConfig(`${config}runtime: {}\n`).runtime).toMatchObject({
      language: "typescript",
      on_overlap: "skip",
    });
  });
});

it.each(["v25.03.0", "^25"])("reads the saved binary rule %s only from a deployment", (rule) => {
  const yaml = `name: legacy\nversion: 1.0.0\ntrigger: { type: webhook }\nruntime:\n  requirements:\n    binaries:\n      - { name: pdftoppm, version: '${rule}' }\n`;
  expect(parseAutomationConfig(yaml, "deployment").runtime.requirements.binaries).toEqual([
    { name: "pdftoppm", version: rule },
  ]);
  expect(() => parseAutomationConfig(yaml)).toThrow("Invalid version rule");
});

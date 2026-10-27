import { assertSecretEncryptionKeyIsConfigured } from "@swizzle/db";
import type { SwizzleAuth } from "@swizzle/db/postgres";
import type { SecurityAuditResponse } from "@swizzle/runtime/http-contract";

import type { ApiServer } from "./http-shared.js";
import { assertPublicSecurityConfiguration } from "./security-config.js";

type SecurityAuditCheck = SecurityAuditResponse["checks"][number];
type SecurityAuditLevel = SecurityAuditCheck["level"];

export function registerSecurityAuditRoute(app: ApiServer, auth: SwizzleAuth): void {
  app.post<{ Reply: SecurityAuditResponse }>(
    "/security/audit",
    async () => await buildSecurityAudit({ auth }),
  );
}

export async function buildSecurityAudit(options: {
  readonly auth: SwizzleAuth;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<SecurityAuditResponse> {
  const environment = options.environment ?? process.env;
  const passwordOnly = await options.auth.accountsWithoutTwoFactor();
  const checks: SecurityAuditCheck[] = [];
  checks.push(
    (await options.auth.setupRequired())
      ? check("account", "First account", "critical", "No one has set up this instance yet.")
      : check("account", "First account", "pass", "This instance is set up."),
  );

  try {
    assertSecretEncryptionKeyIsConfigured(environment);
    checks.push(
      check(
        "encryption-key",
        "Credential encryption",
        "pass",
        "A valid 32-byte encryption key is configured.",
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "encryption-key",
        "Credential encryption",
        "critical",
        error instanceof Error ? error.message : "The encryption key is invalid.",
      ),
    );
  }

  try {
    assertPublicSecurityConfiguration({ ...environment, NODE_ENV: "production" });
    checks.push(
      check(
        "production-config",
        "Public deployment configuration",
        "pass",
        "Public origins, proxy trust, cookies, and control-plane authentication are fail-closed.",
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "production-config",
        "Public deployment configuration",
        "critical",
        error instanceof Error ? error.message : "Production security configuration is invalid.",
      ),
    );
  }

  checks.push(
    rateLimitCheck(
      "webhook-rate-limit",
      "Webhook ingress rate limit",
      environment.SWIZZLE_WEBHOOK_INGRESS_RATE_LIMIT,
      "60/min",
    ),
    rateLimitCheck(
      "approval-rate-limit",
      "Approval route rate limit",
      environment.SWIZZLE_APPROVAL_RATE_LIMIT,
      "30/min",
    ),
    rateLimitCheck(
      "event-callback-rate-limit",
      "Event callback rate limit",
      environment.SWIZZLE_EVENT_CALLBACK_RATE_LIMIT,
      "60/min",
    ),
    check(
      "login-rate-limit",
      "Sign-in brute-force protection",
      "pass",
      "Sign-in budgets per device and account are persisted in PostgreSQL and survive API restarts.",
    ),
    check(
      "security-headers",
      "Browser security headers",
      "pass",
      "CSP, frame protection, content-type protection, referrer policy, and permissions policy are enabled.",
    ),
    environment.SWIZZLE_REQUIRE_SANDBOX?.trim().toLowerCase() === "true"
      ? check(
          "runner-sandbox",
          "Automation process isolation",
          "pass",
          "Deployed runs require non-root, read-only container execution with dropped capabilities and resource limits.",
        )
      : check(
          "runner-sandbox",
          "Automation process isolation",
          "critical",
          "SWIZZLE_REQUIRE_SANDBOX=true is required before exposing an instance that executes automation code.",
        ),
    environment.SWIZZLE_RUNNER_EGRESS_PROXY?.trim()
      ? check(
          "runner-egress",
          "Automation network isolation",
          "pass",
          "Network-enabled runs use the internal runner network and the private-address-blocking HTTP(S) egress proxy.",
        )
      : check(
          "runner-egress",
          "Automation network isolation",
          "critical",
          "No sandbox egress proxy is configured; network-enabled runs could reach private infrastructure or metadata endpoints.",
        ),
    environment.SWIZZLE_CONTROL_EGRESS_PROXY?.trim()
      ? check(
          "control-egress",
          "Control-plane SSRF boundary",
          "pass",
          "Server-side OAuth HTTP requests use the private-address-blocking egress proxy.",
        )
      : check(
          "control-egress",
          "Control-plane SSRF boundary",
          "critical",
          "No control-plane egress proxy is configured; custom OAuth endpoints could reach private infrastructure.",
        ),
    check(
      "machine-token-boundary",
      "Machine credential boundary",
      "pass",
      "Machine tokens can operate automations and create, rotate, revoke, and list metadata for platform secrets; plaintext reads, browser sessions, and machine access-token administration remain unavailable.",
    ),
    passwordOnly === 0
      ? check(
          "mfa",
          "Two-factor sign-in",
          "pass",
          "Every account asks for a code from an authenticator app at every sign-in.",
        )
      : check(
          "mfa",
          "Two-factor sign-in",
          "warning",
          `${passwordOnly === 1 ? "1 account signs" : `${passwordOnly} accounts sign`} in with a password alone. Each person turns on two-factor sign-in in Settings.`,
        ),
    check(
      "edge-abuse-protection",
      "Upstream abuse and DDoS protection",
      "warning",
      "Application rate limits are enabled; volumetric attacks still require host firewall and upstream reverse-proxy protection.",
    ),
  );

  const previousKeys = environment.SWIZZLE_ENCRYPTION_PREVIOUS_KEYS?.trim();
  checks.push(
    previousKeys && previousKeys !== "[]"
      ? check(
          "encryption-rotation",
          "Credential-key rotation",
          "warning",
          "Previous decrypt-only keys are configured. Run just db-reencrypt, verify credentials, then remove the previous-key ring.",
        )
      : check(
          "encryption-rotation",
          "Credential-key rotation",
          "pass",
          "No previous decrypt-only credential keys remain configured.",
        ),
  );

  const summary = {
    critical: checks.filter((entry) => entry.level === "critical").length,
    passed: checks.filter((entry) => entry.level === "pass").length,
    warnings: checks.filter((entry) => entry.level === "warning").length,
  };
  return {
    checkedAt: new Date().toISOString(),
    checks,
    status: summary.critical === 0 ? "ok" : "attention",
    summary,
  };
}

function rateLimitCheck(
  id: string,
  title: string,
  configured: string | undefined,
  defaultValue: string,
): SecurityAuditCheck {
  const value = configured?.trim() || defaultValue;
  const disabled = new Set(["0", "disabled", "false", "off"]).has(value.toLowerCase());
  return disabled
    ? check(id, title, "critical", `${title} is disabled.`)
    : check(id, title, "pass", `${title} is enabled at ${value}.`);
}

function check(
  id: string,
  title: string,
  level: SecurityAuditLevel,
  detail: string,
): SecurityAuditCheck {
  return { detail, id, level, title };
}

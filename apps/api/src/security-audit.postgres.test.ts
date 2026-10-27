import { describe, expect, it } from "vitest";
import { AuthBrowser } from "../../../test/auth-browser.js";
import { authenticatorCode } from "../../../test/authenticator.js";
import { testAuth } from "../../../test/stores.js";
import { buildSecurityAudit } from "./security-audit.js";

const ORIGIN = "https://swizzle.example.com";
const PASSWORD = "correct horse battery staple";

describe("security audit", () => {
  it("reports a hardened public installation that is set up", { timeout: 30_000 }, async () => {
    const auth = testAuth({ trustedOrigins: [ORIGIN] });
    const ada = new AuthBrowser(auth, ORIGIN);
    const created = await ada.post("/sign-up/email", {
      email: "ada@example.com",
      name: "Ada",
      password: PASSWORD,
    });
    expect(created.status).toBe(200);
    const enabled = await ada.post("/two-factor/enable", { password: PASSWORD });
    const secret = new URL(String(enabled.body?.totpURI)).searchParams.get("secret") ?? "";
    await ada.post("/two-factor/verify-totp", { code: authenticatorCode(secret) });

    const report = await buildSecurityAudit({
      environment: {
        API_HOST: "0.0.0.0",
        SWIZZLE_API_ORIGIN: "https://api.example.com",
        SWIZZLE_CORS_ORIGINS: "https://swizzle.example.com",
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://runner-egress-proxy:3128",
        SWIZZLE_DASHBOARD_ORIGIN: "https://swizzle.example.com",
        SWIZZLE_ENCRYPTION_KEY: "12345678901234567890123456789012",
        SWIZZLE_PUBLIC_URL: "https://api.example.com",
        SWIZZLE_REQUIRE_SANDBOX: "true",
        SWIZZLE_RUNNER_EGRESS_PROXY: "http://runner-egress-proxy:3128",
        SWIZZLE_SETUP_TOKEN: "setup-token-at-least-thirty-two-bytes-long",
        SWIZZLE_TRUSTED_PROXY: "10.0.0.0/8",
      },
      auth,
    });

    expect(report.status).toBe("ok");
    expect(report.summary.critical).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "account", level: "pass" }),
        expect.objectContaining({ id: "mfa", level: "pass" }),
        expect.objectContaining({ id: "login-rate-limit", level: "pass" }),
      ]),
    );

    await auth.close();
  });

  it("counts the accounts that sign in with a password alone", { timeout: 30_000 }, async () => {
    const auth = testAuth({ trustedOrigins: [ORIGIN] });
    await new AuthBrowser(auth, ORIGIN).post("/sign-up/email", {
      email: "ada@example.com",
      name: "Ada",
      password: PASSWORD,
    });

    const report = await buildSecurityAudit({ auth, environment: {} });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "mfa",
        level: "warning",
        detail:
          "1 account signs in with a password alone. Each person turns on two-factor sign-in in Settings.",
      }),
    );
    await auth.close();
  });
});

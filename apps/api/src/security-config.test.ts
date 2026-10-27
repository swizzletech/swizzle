import { describe, expect, it } from "vitest";

import { assertPublicSecurityConfiguration, readBooleanSetting } from "./security-config.js";

describe("public security configuration", () => {
  it("accepts the packaged public HTTPS topology", () => {
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "0.0.0.0",
        SWIZZLE_API_ORIGIN: "https://api.example.com",
        SWIZZLE_CORS_ORIGINS: "https://swizzle.example.com",
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://runner-egress-proxy:3128",
        SWIZZLE_DASHBOARD_ORIGIN: "https://swizzle.example.com",
        SWIZZLE_PUBLIC_URL: "https://api.example.com",
        SWIZZLE_SETUP_TOKEN: "setup-token-with-at-least-32-bytes-long",
        SWIZZLE_TRUSTED_PROXY: "10.0.0.0/8",
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("refuses a public production bind without a strong setup token", () => {
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "0.0.0.0",
        SWIZZLE_DASHBOARD_ORIGIN: "https://swizzle.example.com",
        NODE_ENV: "production",
      }),
    ).toThrow(/SWIZZLE_SETUP_TOKEN/u);
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "0.0.0.0",
        SWIZZLE_DASHBOARD_ORIGIN: "https://swizzle.example.com",
        SWIZZLE_SETUP_TOKEN: "too-short",
        NODE_ENV: "production",
      }),
    ).toThrow(/at least 32 bytes/u);
  });

  it("refuses plaintext public origins and the trust-all and hop-count proxy modes", () => {
    expect(() =>
      assertPublicSecurityConfiguration({
        SWIZZLE_DASHBOARD_ORIGIN: "http://swizzle.example.com",
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://runner-egress-proxy:3128",
        SWIZZLE_SETUP_TOKEN: "setup-token-with-at-least-32-bytes-long",
        NODE_ENV: "production",
      }),
    ).toThrow(/must use https/u);
    expect(() =>
      assertPublicSecurityConfiguration({
        SWIZZLE_TRUSTED_PROXY: "true",
        NODE_ENV: "production",
      }),
    ).toThrow(/trusts every upstream/u);
    expect(() =>
      assertPublicSecurityConfiguration({
        SWIZZLE_TRUSTED_PROXY: "1",
        NODE_ENV: "production",
      }),
    ).toThrow(/is a hop count/u);
  });

  it.each(["0", "false", "off", "OFF"])(
    "refuses SWIZZLE_AUTH_COOKIE_SECURE=%s for a public HTTPS origin",
    (value) => {
      expect(() =>
        assertPublicSecurityConfiguration({
          API_HOST: "127.0.0.1",
          SWIZZLE_AUTH_COOKIE_SECURE: value,
          SWIZZLE_PUBLIC_URL: "https://api.example.com",
          NODE_ENV: "production",
        }),
      ).toThrow(/SWIZZLE_AUTH_COOKIE_SECURE cannot be false/u);
    },
  );

  it.each(["__proto__", "constructor"])("refuses the non-boolean spelling %s", (value) => {
    expect(() =>
      readBooleanSetting({ SWIZZLE_AUTH_COOKIE_SECURE: value }, "SWIZZLE_AUTH_COOKIE_SECURE"),
    ).toThrow(/must be true\/false/u);
  });

  it("allows local production packaging over plain HTTP", () => {
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "0.0.0.0",
        SWIZZLE_API_ORIGIN: "http://api.localhost:19826",
        SWIZZLE_LINK_URL: "http://links.localhost:19826",
        SWIZZLE_DASHBOARD_ORIGIN: "http://localhost:19826",
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://runner-egress-proxy:3128",
        SWIZZLE_PUBLIC_URL: "http://api.localhost:19826",
        SWIZZLE_SETUP_TOKEN: "local-setup-token-still-needs-32-bytes",
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("refuses a plaintext public link URL even with local dashboard and API origins", () => {
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "127.0.0.1",
        SWIZZLE_LINK_URL: "http://links.example.com",
        SWIZZLE_DASHBOARD_ORIGIN: "http://localhost:19826",
        NODE_ENV: "production",
      }),
    ).toThrow(/SWIZZLE_LINK_URL.*must use https/u);
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "127.0.0.1",
        SWIZZLE_LINK_URL: "https://links.example.com",
        SWIZZLE_LINK_ORIGIN: "http://links.localhost:19826",
        SWIZZLE_AUTH_COOKIE_SECURE: "false",
        SWIZZLE_DASHBOARD_ORIGIN: "http://localhost:19826",
        NODE_ENV: "production",
      }),
    ).not.toThrow();
  });

  it("refuses proxy URLs containing credentials", () => {
    expect(() =>
      assertPublicSecurityConfiguration({
        API_HOST: "0.0.0.0",
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://user:secret@proxy.example:3128",
        SWIZZLE_SETUP_TOKEN: "setup-token-with-at-least-32-bytes-long",
        NODE_ENV: "production",
      }),
    ).toThrow(/must not embed credentials/u);
  });
});

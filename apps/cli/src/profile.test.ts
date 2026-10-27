import { describe, expect, it } from "vitest";

import {
  parseProfileToml,
  removeProfile,
  resolveEnvironment,
  resolveProfile,
  serializeProfileToml,
  setDefaultProfile,
  upsertProfile,
} from "./profile.js";

describe("profile parser", () => {
  it("round-trips a non-trivial config", () => {
    const raw = `
# local defaults
default_profile = "local"

[profile.local]
url = "http://localhost:19820"

[profile.prod]
url = "https://swizzle.example.com"
env = "prod"
token_env = "SWIZZLE_PROD_TOKEN"

[profile.staging]
url = "https://staging.swizzle.example.com"
token = "inline-token"
`;
    const config = parseProfileToml(raw);
    expect(config.defaultProfile).toBe("local");
    expect(config.profiles.local?.url).toBe("http://localhost:19820");
    expect(config.profiles.prod?.tokenEnv).toBe("SWIZZLE_PROD_TOKEN");
    expect(config.profiles.prod?.environment).toBe("prod");
    expect(config.profiles.staging?.token).toBe("inline-token");

    const serialized = serializeProfileToml(config);
    const reparsed = parseProfileToml(serialized);
    expect(reparsed).toEqual(config);
  });

  it("requires a url per profile", () => {
    expect(() => parseProfileToml(`[profile.broken]\ntoken = "x"`)).toThrow(
      /missing required field "url"/,
    );
  });
});

describe("resolveEnvironment precedence", () => {
  it("prefers the explicit flag over everything", () => {
    const resolved = resolveEnvironment({
      flag: "staging",
      profileEnvironment: "prod",
      env: { SWIZZLE_ENVIRONMENT: "ci" },
    });
    expect(resolved).toEqual({ environment: "staging", source: "flag" });
  });

  it("prefers the profile environment over the env var", () => {
    const resolved = resolveEnvironment({
      profileEnvironment: "prod",
      env: { SWIZZLE_ENVIRONMENT: "ci" },
    });
    expect(resolved).toEqual({ environment: "prod", source: "profile" });
  });

  it("falls back to SWIZZLE_ENVIRONMENT when no flag or profile is set", () => {
    const resolved = resolveEnvironment({ env: { SWIZZLE_ENVIRONMENT: "ci" } });
    expect(resolved).toEqual({ environment: "ci", source: "env" });
  });

  it("reports a named profile with no pinned environment as unpinned", () => {
    const resolved = resolveEnvironment({
      env: {},
      profileName: "prod",
    });
    expect(resolved).toEqual({ environment: null, source: "unpinned", profileName: "prod" });
  });

  it("does not fail a named profile when the flag pins the environment", () => {
    const resolved = resolveEnvironment({
      flag: "prod",
      env: {},
      profileName: "prod",
    });
    expect(resolved).toEqual({ environment: "prod", source: "flag" });
  });

  it("does not fail a named profile when SWIZZLE_ENVIRONMENT pins the environment", () => {
    const resolved = resolveEnvironment({
      env: { SWIZZLE_ENVIRONMENT: "ci" },
      profileName: "prod",
    });
    expect(resolved).toEqual({ environment: "ci", source: "env" });
  });

  it("ignores blank/whitespace inputs and keeps resolving down the chain", () => {
    const resolved = resolveEnvironment({
      flag: "   ",
      profileEnvironment: "",
      env: { SWIZZLE_ENVIRONMENT: "  " },
    });
    expect(resolved).toEqual({ environment: null, source: "unpinned" });
  });
});

describe("resolveProfile precedence", () => {
  const config = {
    defaultProfile: "local",
    profiles: {
      local: { name: "local", url: "http://localhost:19820" },
      prod: {
        name: "prod",
        url: "https://swizzle.example.com",
        tokenEnv: "PROD_TOKEN",
      },
    },
  };

  it("uses the explicit --profile flag first", () => {
    const resolved = resolveProfile({
      profile: "prod",
      config,
      env: { PROD_TOKEN: "secret-prod" },
    });
    expect(resolved.name).toBe("prod");
    expect(resolved.source).toBe("flag");
    expect(resolved.token).toBe("secret-prod");
  });

  it("falls back to SWIZZLE_PROFILE env when no flag is given", () => {
    const resolved = resolveProfile({
      config,
      env: { SWIZZLE_PROFILE: "prod", PROD_TOKEN: "env-token" },
    });
    expect(resolved.name).toBe("prod");
    expect(resolved.source).toBe("env");
    expect(resolved.token).toBe("env-token");
  });

  it("uses the configured default profile when no flag/env is set", () => {
    const resolved = resolveProfile({ config, env: {} });
    expect(resolved.name).toBe("local");
    expect(resolved.source).toBe("default");
    expect(resolved.token).toBe(null);
  });

  it("requires sign-in when no profile is configured, even with an API URL override", () => {
    for (const input of [
      { env: {} },
      { env: { SWIZZLE_API_URL: "http://localhost:19820" } },
      { env: {}, apiUrl: "http://localhost:19820" },
    ]) {
      expect(() => resolveProfile(input)).toThrow(
        "No CLI profile is configured. Sign in to use the API.",
      );
    }
  });

  it("throws when --profile points to an unknown profile", () => {
    expect(() =>
      resolveProfile({
        profile: "does-not-exist",
        config,
        env: {},
      }),
    ).toThrow(/not configured/);
  });
});

describe("config mutators", () => {
  it("upserts and removes profiles while preserving the default", () => {
    let config = parseProfileToml("");
    config = upsertProfile(config, {
      name: "prod",
      url: "https://api.example.com",
      tokenEnv: "TOKEN",
    });
    config = setDefaultProfile(config, "prod");
    expect(config.defaultProfile).toBe("prod");

    config = upsertProfile(config, { name: "staging", url: "https://staging.example.com" });
    expect(Object.keys(config.profiles)).toEqual(["prod", "staging"]);

    config = removeProfile(config, "staging");
    expect(config.profiles.staging).toBeUndefined();
    expect(config.defaultProfile).toBe("prod");

    config = removeProfile(config, "prod");
    expect(config.defaultProfile).toBeUndefined();
  });
});

import {
  ConfigurationError,
  parseEgressProxyUrl,
  SWIZZLE_CONTROL_EGRESS_PROXY_ENV,
} from "@swizzle/core";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);
const MINIMUM_SETUP_TOKEN_BYTES = 32;

class PublicSecurityConfigurationError extends ConfigurationError {
  constructor(message: string) {
    super("INSECURE_PRODUCTION_CONFIGURATION", message);
    this.name = "PublicSecurityConfigurationError";
  }
}

export function assertPublicSecurityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (environment.NODE_ENV?.trim().toLowerCase() !== "production") return;

  const host = environment.API_HOST?.trim() || "0.0.0.0";
  const trustedProxy = environment.SWIZZLE_TRUSTED_PROXY?.trim().toLowerCase();
  if (trustedProxy === "true") {
    throw new PublicSecurityConfigurationError(
      "SWIZZLE_TRUSTED_PROXY=true trusts every upstream. Use the proxy's address or CIDR.",
    );
  }
  // Fastify reads a hop count such as 1 as the address 0.0.0.1, which no proxy has, so every
  // client would share the proxy's address and its rate-limit budget.
  if (trustedProxy !== undefined && /^[1-9]\d*$/u.test(trustedProxy)) {
    throw new PublicSecurityConfigurationError(
      `SWIZZLE_TRUSTED_PROXY=${trustedProxy} is a hop count, which Fastify reads as an address. Use the proxy's address or CIDR.`,
    );
  }

  if (!isLoopbackHost(host)) {
    const setupToken = environment.SWIZZLE_SETUP_TOKEN?.trim() ?? "";
    if (Buffer.byteLength(setupToken, "utf8") < MINIMUM_SETUP_TOKEN_BYTES) {
      throw new PublicSecurityConfigurationError(
        `SWIZZLE_SETUP_TOKEN must contain at least ${MINIMUM_SETUP_TOKEN_BYTES} bytes when a production API binds to a non-loopback host. It protects an unclaimed instance from first-visitor owner takeover.`,
      );
    }
    assertControlEgressProxy(environment.SWIZZLE_CONTROL_EGRESS_PROXY);
  }

  const origins = [
    ["SWIZZLE_DASHBOARD_ORIGIN", environment.SWIZZLE_DASHBOARD_ORIGIN],
    ["SWIZZLE_API_ORIGIN", environment.SWIZZLE_API_ORIGIN],
    ["SWIZZLE_PUBLIC_URL", environment.SWIZZLE_PUBLIC_URL],
    ["SWIZZLE_LINK_URL", environment.SWIZZLE_LINK_URL],
    ...splitOrigins(environment.SWIZZLE_CORS_ORIGINS).map(
      (origin) => ["SWIZZLE_CORS_ORIGINS", origin] as const,
    ),
  ] as const;
  let hasPublicHttpsOrigin = false;
  for (const [name, rawOrigin] of origins) {
    const origin = rawOrigin?.trim();
    if (!origin) continue;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new PublicSecurityConfigurationError(`${name} contains an invalid URL: ${origin}`);
    }
    if (isLoopbackHost(parsed.hostname)) continue;
    if (parsed.protocol !== "https:") {
      throw new PublicSecurityConfigurationError(
        `${name} must use https for a non-local production origin: ${origin}`,
      );
    }
    if (name !== "SWIZZLE_LINK_URL") hasPublicHttpsOrigin = true;
  }

  if (
    hasPublicHttpsOrigin &&
    readBooleanSetting(environment, "SWIZZLE_AUTH_COOKIE_SECURE") === false
  ) {
    throw new PublicSecurityConfigurationError(
      "SWIZZLE_AUTH_COOKIE_SECURE cannot be false for a public HTTPS production origin.",
    );
  }
}

function assertControlEgressProxy(value: string | undefined): void {
  const proxy = value?.trim() ?? "";
  if (!proxy) {
    throw new PublicSecurityConfigurationError(
      `${SWIZZLE_CONTROL_EGRESS_PROXY_ENV} is required for a public production API so OAuth and other server-side HTTP requests cannot reach private infrastructure.`,
    );
  }
  parseEgressProxyUrl(SWIZZLE_CONTROL_EGRESS_PROXY_ENV, proxy);
}

function splitOrigins(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// A Map, so a spelling such as `__proto__` finds nothing instead of an Object.prototype member.
const BOOLEAN_SPELLINGS: ReadonlyMap<string, boolean> = new Map([
  ["0", false],
  ["1", true],
  ["false", false],
  ["no", false],
  ["off", false],
  ["on", true],
  ["true", true],
  ["yes", true],
]);

/**
 * The one reader of boolean settings such as SWIZZLE_AUTH_COOKIE_SECURE, so the startup guard and
 * the code that acts on a setting agree on every spelling. Undefined when the setting is unset or
 * empty; any spelling other than true/false, 1/0, on/off or yes/no throws.
 */
export function readBooleanSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const raw = environment[name]?.trim().toLowerCase() ?? "";
  if (raw.length === 0) return undefined;
  const value = BOOLEAN_SPELLINGS.get(raw);
  if (value === undefined) {
    throw new ConfigurationError(
      "AUTOMATION_CONFIG_INVALID",
      `${name} must be true/false, 1/0, on/off or yes/no.`,
    );
  }
  return value;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.endsWith(".localhost");
}

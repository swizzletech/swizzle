import type { AgentOptions } from "node:https";
import type { Dispatcher, ProxyAgent } from "undici";

import { ConfigurationError } from "./boot.js";

export const SWIZZLE_CONTROL_EGRESS_PROXY_ENV = "SWIZZLE_CONTROL_EGRESS_PROXY";

export class EgressProxyConfigurationError extends ConfigurationError {
  constructor(message: string, options?: ErrorOptions) {
    super("EGRESS_PROXY_INVALID", message, options);
    this.name = "EgressProxyConfigurationError";
  }
}

export function parseEgressProxyUrl(variable: string, value: string): URL {
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch (error) {
    throw new EgressProxyConfigurationError(
      `${variable} must be a URL such as http://runner-egress-proxy:3128.`,
      { cause: error },
    );
  }
  if (proxy.protocol !== "http:") {
    throw new EgressProxyConfigurationError(
      `${variable} must use http, as in http://runner-egress-proxy:3128.`,
    );
  }
  if (proxy.username || proxy.password) {
    throw new EgressProxyConfigurationError(
      `${variable} must not embed credentials. Configure proxy authentication outside the URL so secrets cannot leak through diagnostics or process metadata.`,
    );
  }
  return proxy;
}

function readControlEgressProxy(environment: NodeJS.ProcessEnv): URL | null {
  const raw = environment[SWIZZLE_CONTROL_EGRESS_PROXY_ENV]?.trim();
  return raw ? parseEgressProxyUrl(SWIZZLE_CONTROL_EGRESS_PROXY_ENV, raw) : null;
}

let directDispatcher: Dispatcher | undefined;
let proxyAgent: ProxyAgent | undefined;

export async function configureOutboundHttpProxy(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const proxy = readControlEgressProxy(environment);
  if (proxy === null) return false;

  const undici = await import("undici");
  directDispatcher ??= undici.getGlobalDispatcher();
  proxyAgent = new undici.ProxyAgent(proxy.href);
  undici.setGlobalDispatcher(proxyAgent);
  return true;
}

export async function resetOutboundHttpProxy(): Promise<void> {
  if (directDispatcher !== undefined)
    (await import("undici")).setGlobalDispatcher(directDispatcher);
  await proxyAgent?.close();
  directDispatcher = undefined;
  proxyAgent = undefined;
}

export function controlEgressAgentOptions(
  environment: NodeJS.ProcessEnv = process.env,
): AgentOptions {
  const proxy = readControlEgressProxy(environment);
  return proxy === null ? {} : { proxyEnv: { HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href } };
}

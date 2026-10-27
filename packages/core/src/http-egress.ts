// In the Compose stack the api and the worker reach the internet only through the control egress
// proxy. `configureOutboundHttpProxy` sends fetch through it; `controlEgressAgentOptions` sends the
// clients that use node:http and node:https directly through it: the S3 client and the OTLP exporter.

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

/**
 * The one rule for an egress proxy URL, read from `variable`: a plain HTTP proxy such as
 * http://runner-egress-proxy:3128, with no credentials. The API checks SWIZZLE_CONTROL_EGRESS_PROXY
 * with it at startup, configureOutboundHttpProxy and controlEgressAgentOptions before they route
 * requests through the proxy, and the container runner SWIZZLE_RUNNER_EGRESS_PROXY before a sandboxed run gets its host and port.
 */
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

/** The validated SWIZZLE_CONTROL_EGRESS_PROXY, or null when it is unset. */
function readControlEgressProxy(environment: NodeJS.ProcessEnv): URL | null {
  const raw = environment[SWIZZLE_CONTROL_EGRESS_PROXY_ENV]?.trim();
  return raw ? parseEgressProxyUrl(SWIZZLE_CONTROL_EGRESS_PROXY_ENV, raw) : null;
}

let directDispatcher: Dispatcher | undefined;
let proxyAgent: ProxyAgent | undefined;

/**
 * Route Node's global fetch through the operator-controlled HTTP proxy. It replaces the
 * process-wide undici dispatcher, which every fetch in the process uses; the API and the worker
 * call it once at startup. undici loads only when a proxy is configured: it takes longer to import
 * than the rest of core, and every importer of core would pay for it.
 */
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

/** Undo configureOutboundHttpProxy: fetch dispatches directly again. Tests call it after each case. */
export async function resetOutboundHttpProxy(): Promise<void> {
  if (directDispatcher !== undefined)
    (await import("undici")).setGlobalDispatcher(directDispatcher);
  await proxyAgent?.close();
  directDispatcher = undefined;
  proxyAgent = undefined;
}

/**
 * Options for a node:http or node:https Agent that sends its requests through the control egress
 * proxy with Node's built-in proxy support, or no options when none is configured.
 */
export function controlEgressAgentOptions(
  environment: NodeJS.ProcessEnv = process.env,
): AgentOptions {
  const proxy = readControlEgressProxy(environment);
  return proxy === null ? {} : { proxyEnv: { HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href } };
}

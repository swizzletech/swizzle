import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  configureOutboundHttpProxy,
  EgressProxyConfigurationError,
  resetOutboundHttpProxy,
} from "./http-egress.js";

afterEach(resetOutboundHttpProxy);

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return `127.0.0.1:${port}`;
}

describe("outbound HTTP proxy configuration", () => {
  it("rejects unsupported schemes and embedded credentials", async () => {
    await expect(
      configureOutboundHttpProxy({ SWIZZLE_CONTROL_EGRESS_PROXY: "socks://proxy:1080" }),
    ).rejects.toThrow(EgressProxyConfigurationError);
    await expect(
      configureOutboundHttpProxy({
        SWIZZLE_CONTROL_EGRESS_PROXY: "http://user:secret@proxy.example:3128",
      }),
    ).rejects.toThrow(/must not embed credentials/u);
  });

  it("sends a form POST, as the OAuth adapters make it, through the proxy", async () => {
    const received: { body: string; contentLength: string | undefined }[] = [];
    const target = await listen(
      createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        received.push({ body, contentLength: request.headers["content-length"] });
        response.end("ok");
      }),
    );
    // ProxyAgent sends a request for an http:// target to the proxy in absolute form.
    const proxied: string[] = [];
    const proxy = createServer((request, response) => {
      proxied.push(`${request.method} ${request.url}`);
      const upstream = httpRequest(
        request.url ?? "",
        { headers: request.headers, method: request.method },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      request.pipe(upstream);
    });
    const proxyAddress = await listen(proxy);

    await configureOutboundHttpProxy({ SWIZZLE_CONTROL_EGRESS_PROXY: `http://${proxyAddress}` });
    const response = await fetch(`http://${target}/token`, {
      body: new URLSearchParams({ grant_type: "refresh_token" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    expect(await response.text()).toBe("ok");
    expect(proxied).toEqual([`POST http://${target}/token`]);
    expect(received).toEqual([{ body: "grant_type=refresh_token", contentLength: "24" }]);
  });
});

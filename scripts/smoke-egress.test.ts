import { expect, it, vi } from "vitest";
import type { PackagedStack } from "./packaged-stack.mts";
import { smokeRunnerEgress } from "./smoke-egress.mts";

it("accepts both Squid log tags for a denied loopback CONNECT", async () => {
  const proxyLogs = [
    "1795197646.842 2 172.22.0.4 TCP_DENIED_ABORTED/403 303 CONNECT 127.0.0.1:80 - HIER_NONE/- text/html",
    "1795197648.892 0 172.22.0.5 TCP_DENIED/403 303 CONNECT 127.0.0.1:80 - HIER_NONE/- text/html",
  ];
  let queued = 0;
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ runId: String(++queued) });
    return Response.json({ status: "succeeded", result: { status: 401, privateDenied: true } });
  });
  const stack: PackagedStack = {
    project: "egress-test",
    envFile: "/unused",
    environment: "production",
    dashboard: "http://test.invalid",
    api: "http://test.invalid",
    links: "http://test.invalid",
    token: "test-token",
    session: { name: "unused", value: "unused" },
    cli: async () => "",
    compose: async () => {
      now += 181_000;
      return proxyLogs.slice(0, queued).join("\n");
    },
    remove: async () => {},
  };
  const messages: string[] = [];
  await smokeRunnerEgress(stack, (message) => messages.push(message));
  expect(messages.filter((message) => message.includes("proxy refused private CONNECT"))).toEqual([
    "egress-python: received HTTP 401; proxy refused private CONNECT with 403",
    "egress-typescript: received HTTP 401; proxy refused private CONNECT with 403",
  ]);
});

import type { MockRoute } from "./route";

export function health({ is, json }: MockRoute) {
  if (is("GET", /^\/health$/u)) return json({ service: "api", status: "ok", version: "0.9.0" });
  return undefined;
}

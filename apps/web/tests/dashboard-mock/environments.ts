import type { MockRoute } from "./route";

export function environments({ is, json }: MockRoute) {
  if (is("GET", /^\/environments$/u)) {
    return json({
      defaultEnvironment: "staging",
      environments: [{ name: "staging" }, { name: "production" }],
    });
  }
  return undefined;
}

import type { MockRoute } from "./route";

export function notifications({ is, json }: MockRoute) {
  if (is("GET", /^\/notifications\/(rules|deliveries)$/u)) {
    return json({ deliveries: [], environment: "staging", rules: [] });
  }
  return undefined;
}

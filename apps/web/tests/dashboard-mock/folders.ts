import type { MockRoute } from "./route";
import type { MockState } from "./state";

export function folders({ is, json }: MockRoute, state: MockState) {
  if (is("GET", /^\/automation-folders$/u)) return json(state.folders);
  return undefined;
}

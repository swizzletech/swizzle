import type {
  AutomationDetail,
  AutomationFoldersResponse,
  AutomationSummary,
  ListedConnection,
  Overview,
  Project,
  RunDetail,
  RunStep,
  RunsResponse,
  SecretMetadata,
  TokenResponse,
} from "../../src/lib/api";
import type { MockRequest } from "./route";

export interface MockState {
  automations: AutomationSummary[];
  connections: ListedConnection[];
  overview: Overview;
  projects: Project[];
  readonly requests: MockRequest[];
  readonly runDetails: Map<string, RunDetail>;
  readonly runLists: Map<string, RunsResponse>;
  readonly runSteps: Map<string, readonly RunStep[]>;
  secrets: SecretMetadata[];
  tokens: TokenResponse[];
  automationRefusals: AutomationDetail["refusals"];
  folders: AutomationFoldersResponse;
  readonly unhandled: string[];
}

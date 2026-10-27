import { ConfigurationError } from "@swizzle/core";
import { isDockerAvailable } from "@swizzle/runtime";

export class WorkerSecurityConfigurationError extends ConfigurationError {
  constructor(message: string) {
    super("INSECURE_WORKER_CONFIGURATION", message);
    this.name = "WorkerSecurityConfigurationError";
  }
}

export async function assertWorkerSecurityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const production = environment.NODE_ENV?.trim().toLowerCase() === "production";
  const sandboxRequired = environment.SWIZZLE_REQUIRE_SANDBOX?.trim().toLowerCase() === "true";

  if (production && !sandboxRequired) {
    throw new WorkerSecurityConfigurationError(
      "Production workers require SWIZZLE_REQUIRE_SANDBOX=true. Host-process execution is only supported for trusted local development.",
    );
  }
  if (production && !environment.SWIZZLE_CONTROL_EGRESS_PROXY?.trim()) {
    throw new WorkerSecurityConfigurationError(
      "Production workers require SWIZZLE_CONTROL_EGRESS_PROXY for outbound control traffic. OAuth refresh stays on the server.",
    );
  }
  if (sandboxRequired && !(await isDockerAvailable())) {
    throw new WorkerSecurityConfigurationError(
      "The container sandbox is required, but the worker cannot reach its configured Docker API proxy.",
    );
  }
}

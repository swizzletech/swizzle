import os from "node:os";

export interface ResolveServiceInstanceIdOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly hostname?: string;
  readonly service: string;
}

export function resolveServiceInstanceId(options: ResolveServiceInstanceIdOptions): string {
  const env = options.env ?? process.env;
  const override = env.SWIZZLE_INSTANCE_ID?.trim();
  if (override) {
    return override;
  }

  const hostname = options.hostname ?? os.hostname();
  return `${options.service}-${hostname}`;
}

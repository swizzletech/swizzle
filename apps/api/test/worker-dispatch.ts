import { ExecutionLeaseError } from "@swizzle/db";
import type { ServerDispatch } from "@swizzle/runtime/platform";

/** A protocol boundary for HTTP authorization tests; lease transactions run in verify-dispatch. */
export const dispatch: ServerDispatch = {
  async recordRunImage() {},
  async runImageKeep() {
    return [];
  },
  async preparations() {
    return { activeIds: [], deployments: [] };
  },
  async pull() {
    return null;
  },
  async renew() {
    throw new ExecutionLeaseError();
  },
  async source() {
    return [];
  },
  async start() {
    return {};
  },
  async ready() {},
  async output() {},
  async complete() {},
  stop() {},
  async close() {},
};

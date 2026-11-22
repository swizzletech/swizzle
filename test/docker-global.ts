import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";
import { sweepDockerFixtures } from "./docker-images.js";
import { registerProjectCleanup } from "./project-cleanup.js";

export default function setup(project: TestProject): void {
  const run = randomUUID();
  const label = `swizzle.test.run=${run}`;
  project.provide("dockerRun", { run, label });
  registerProjectCleanup(project.vitest, () => sweepDockerFixtures(label));
}

declare module "vitest" {
  export interface ProvidedContext {
    dockerRun: { run: string; label: string };
  }
}

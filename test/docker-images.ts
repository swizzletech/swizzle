import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
type Resource = "container" | "image";

export function sweepDockerFixtures(label: string): void {
  const run = (args: string[]) =>
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  for (const kind of ["container", "image"] as const) {
    const references = run(listArguments(kind, label)).split("\n").filter(Boolean);
    const errors: unknown[] = [];
    for (const reference of new Set(references)) {
      try {
        run(removeArguments(kind, reference));
      } catch (error) {
        if (!isMissing(kind, reference, error)) errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Removing fixture ${kind}s failed`);
  }
}

export async function removeContainersWithLabel(label: string): Promise<void> {
  const containers = await resourcesWithLabel("container", label);
  await removeDockerResources("container", containers);
}

export async function removeImagesWithLabel(label: string, signal?: AbortSignal): Promise<void> {
  const images = await resourcesWithLabel("image", label, signal);
  await removeDockerImages(images, signal);
}

async function resourcesWithLabel(
  kind: Resource,
  label: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const { stdout } = await execute("docker", listArguments(kind, label), { signal });
  return stdout.split("\n").filter(Boolean);
}

export function removeDockerImages(
  references: Iterable<string>,
  signal?: AbortSignal,
): Promise<void> {
  return removeDockerResources("image", references, signal);
}

async function removeDockerResources(
  kind: Resource,
  references: Iterable<string>,
  signal?: AbortSignal,
): Promise<void> {
  const removals = await Promise.allSettled(
    Array.from(new Set(references), async (reference) => {
      try {
        await execute("docker", removeArguments(kind, reference), { signal });
      } catch (error) {
        if (!isMissing(kind, reference, error)) throw error;
      }
    }),
  );
  const errors = removals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) throw new AggregateError(errors, `Removing fixture ${kind}s failed`);
}

function listArguments(kind: Resource, label: string): string[] {
  return [kind, "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=${label}`];
}

function removeArguments(kind: Resource, reference: string): string[] {
  const option = kind === "container" ? "--volumes" : "--no-prune";
  return [kind, "rm", "--force", option, reference];
}

function isMissing(kind: Resource, reference: string, error: unknown): boolean {
  return error instanceof Error && error.message.includes(`No such ${kind}: ${reference}`);
}

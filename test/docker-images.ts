import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function removeImagesWithLabel(label: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await execute(
    "docker",
    ["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=${label}`],
    { signal },
  );
  await removeDockerImages(stdout.split("\n").filter(Boolean), signal);
}

export async function removeDockerImages(
  references: Iterable<string>,
  signal?: AbortSignal,
): Promise<void> {
  const removals = await Promise.allSettled(
    Array.from(new Set(references), async (reference) => {
      try {
        await execute("docker", ["image", "rm", "--force", "--no-prune", reference], { signal });
      } catch (error) {
        if (!(error instanceof Error && error.message.includes(`No such image: ${reference}`)))
          throw error;
      }
    }),
  );
  const errors = removals.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length > 0) throw new AggregateError(errors, "Removing fixture images failed");
}

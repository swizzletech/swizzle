// Reads an image's build record without executing its code or giving the API Docker access.
import { randomUUID } from "node:crypto";
import { Parser } from "tar";
import { containerLimitArguments } from "./container-limits.js";
import { DockerScope, sandboxProcessLabel, stackLabel, workerLabel } from "./docker-cli.js";
import { getErrorMessage } from "./errors.js";
import { isSafeImageReference } from "./run-image.js";
import type { RunnerImageReport, RunnerImageRequest } from "./runner-image-checks.js";
import { collectWorkerCapabilities, parseRunnerTools } from "./runtime-requirements.js";
import { SANDBOX_USER } from "./sandbox.js";

export async function inspectRunnerImage(request: RunnerImageRequest): Promise<RunnerImageReport> {
  if (!isSafeImageReference(request.image))
    return {
      id: request.id,
      result: {
        kind: "unavailable",
        message: "runtime.container.base_image must be a single valid container image reference.",
      },
    };
  const name = `swizzle-run-image-check-${randomUUID()}`;
  const scope = new DockerScope({ timeoutMs: 60_000, containerName: name });
  try {
    await scope.run(
      [
        "create",
        "--name",
        name,
        "--label",
        stackLabel(),
        "--label",
        workerLabel(),
        "--label",
        sandboxProcessLabel(),
        "--user",
        SANDBOX_USER,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        ...containerLimitArguments({}),
        "--network",
        "none",
        "--entrypoint",
        "/bin/sh",
        request.image,
        "-c",
        "true",
      ],
      { outputLimitBytes: 4096 },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      await scope.run(["cp", `${name}:/etc/swizzle/runner-tools.json`, "-"], {
        deadline: "transfer",
        outputLimitBytes: 1_048_576,
        onStdoutBytes: (chunk) => {
          bytes += chunk.length;
          if (bytes > 1_048_576) throw new Error("Runner inventory exceeds 1 MiB.");
          chunks.push(chunk);
          return undefined;
        },
      });
    } catch (error) {
      if (
        getErrorMessage(error).includes(
          "Could not find the file /etc/swizzle/runner-tools.json in container ",
        )
      )
        return { id: request.id, result: { kind: "unverified" } };
      throw error;
    }
    let record = "";
    const parser = new Parser({
      onReadEntry: (entry) => {
        if (entry.path === "runner-tools.json" && entry.type === "File") {
          entry.on("data", (chunk: Buffer) => {
            record += chunk.toString("utf8");
          });
        } else entry.resume();
      },
    });
    await new Promise<void>((resolve, reject) => {
      parser.once("end", resolve);
      parser.once("error", reject);
      parser.end(Buffer.concat(chunks));
    });
    return {
      id: request.id,
      result: {
        kind: "ready",
        capabilities: await collectWorkerCapabilities(parseRunnerTools(record)),
      },
    };
  } catch (error) {
    return {
      id: request.id,
      result: {
        kind: "unavailable",
        message:
          `${getErrorMessage(error)}. Rebuild the image's /etc/swizzle/runner-tools.json inventory.`.slice(
            0,
            4096,
          ),
      },
    };
  } finally {
    await scope.close();
  }
}

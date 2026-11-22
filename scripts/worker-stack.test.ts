import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { temporaryDirectory } from "../test/support.js";

const execute = promisify(execFile);

it.each([
  { shell: "1", credential: "2" },
  { shell: "2", credential: "1" },
])(
  "uses shell CPU limit $shell before credential limit $credential",
  async ({ shell, credential }) => {
    const directory = await temporaryDirectory("swizzle-worker-stack-");
    const checkout = path.join(directory, "checkout");
    const file = path.join(directory, "worker.env");
    const builds = path.join(directory, "builds");
    await mkdir(checkout);
    await writeFile(
      file,
      `SWIZZLE_WORKER_ID=worker
SWIZZLE_WORKER_API_URL=http://127.0.0.1:19820
SWIZZLE_WORKER_TOKEN=test-token
SWIZZLE_WORKER_CPUS=${credential}
SWIZZLE_MAX_RUN_CPUS=${credential}
`,
    );
    await writeFile(
      path.join(directory, "docker"),
      `#!/bin/sh
case "$*" in
  "context show") echo test ;;
  "context inspect test --format {{.Endpoints.docker.Host}}") echo unix:///test.sock ;;
  "info --format {{.OSType}}/{{.Architecture}}") echo linux/x86_64 ;;
  "info --format {{.NCPU}}") echo 1 ;;
  "compose "*build) printf '%s %s\\n' "$SWIZZLE_WORKER_CPUS" "$SWIZZLE_MAX_RUN_CPUS" >> "$TEST_BUILDS" ;;
  "compose "*" run "*) cat >/dev/null ;;
  "compose "*" up "*) ;;
  *) echo "Unexpected Docker command: $*" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    const start = execute(
      process.execPath,
      [fileURLToPath(new URL("worker-stack.mts", import.meta.url)), file],
      {
        cwd: checkout,
        env: {
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          DOCKER_CONTEXT: "test",
          COMPOSE_PROJECT_NAME: "test-worker",
          TEST_BUILDS: builds,
          SWIZZLE_WORKER_CPUS: shell,
          SWIZZLE_MAX_RUN_CPUS: shell,
        },
      },
    );
    if (shell === "1") {
      await expect(start).resolves.toMatchObject({
        stdout: expect.stringContaining("Worker stack test-worker is healthy."),
      });
      expect(await readFile(builds, "utf8")).toBe("1 1\n");
    } else {
      await expect(start).rejects.toMatchObject({
        stderr: expect.stringContaining(
          `SWIZZLE_WORKER_CPUS=2 exceeds the 1 CPU of the Docker host. Compose reads it from the shell before ${file}.`,
        ),
      });
      await expect(readFile(builds, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

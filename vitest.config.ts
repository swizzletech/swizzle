import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TestRunReporter } from "./scripts/test-run-reporter.js";
import { ParallelSequencer } from "./scripts/test-sequencer.js";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Every run owns one directory under the OS temp dir. The env below points
// every default state path into it. Unit tests point service URLs at closed ports;
// the postgres project injects its own disposable database and never reaches a dev database.
// The directory is named here and created on first use, because tools such as
// knip load this file without running a test.
const runDirectory = path.join(os.tmpdir(), `swizzle-test-${randomUUID()}`);

export default defineConfig({
  // Tests import workspace packages from source through the export condition every package
  // declares, so a fresh clone needs no build. The node test environment resolves as ssr.
  ssr: { resolve: { conditions: ["swizzle-source"] } },
  test: {
    sequence: { sequencer: ParallelSequencer },
    environment: "node",
    globals: true,
    env: {
      SWIZZLE_DEP_CACHE_DIR: path.join(runDirectory, "dep-cache"),
      DATABASE_URL: "postgresql://swizzle-tests@127.0.0.1:1/unreachable",
      LOG_LEVEL: "silent",
      PYTHONPYCACHEPREFIX: path.join(runDirectory, "pycache"),
      VALKEY_URL: "redis://127.0.0.1:1",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "apps/**/*.test.ts",
            "packages/**/*.test.ts",
            "scripts/**/*.test.ts",
            ".agents/checks/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          exclude: [
            "**/*.postgres.test.ts",
            "**/*.docker.test.ts",
            "**/dist/**",
            "**/node_modules/**",
          ],
          // The slowest start real processes, such as tracing startup and the dev stack's
          // descendants, and take over half a minute on a host shared with other worktrees.
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: "docker",
          include: ["**/*.docker.test.ts"],
          exclude: ["**/dist/**", "**/node_modules/**"],
          // These build and load real images on the host's Docker daemon, which other worktrees'
          // runs share. They hold the code's Docker deadlines, so this ceiling is their only bound.
          testTimeout: 600_000,
        },
      },
      {
        extends: true,
        test: {
          name: "postgres",
          include: ["**/*.postgres.test.ts"],
          globalSetup: ["test/postgres-global.ts"],
          setupFiles: ["test/process-leaks.ts", "test/warnings.ts", "test/postgres-setup.ts"],
          env: {
            SWIZZLE_ENCRYPTION_KEY: "12345678901234567890123456789012",
            // These fixtures fake Docker on PATH; a late call must never reach the host daemon.
            DOCKER_HOST: `unix://${path.join(runDirectory, "docker.sock")}`,
          },
          // The slowest run several CLI processes or a state machine's checks against a migrated
          // database; the README steps test takes 37 s on a host shared with other worktrees.
          testTimeout: 120_000,
        },
      },
    ],
    // Four workers overlap process lifecycle and database tests while bounding the child
    // processes on a host shared with other worktrees and load tests.
    maxWorkers: 4,
    // With each project's testTimeout, the only timeouts: a test sets none of its own
    // (tests-wait-on-state). They are hang tripwires, not performance assertions.
    hookTimeout: 30_000,
    // Before each test, undo every vi.stubEnv, vi.stubGlobal and vi.spyOn of the test before, so
    // no test file keeps its own list of what to put back.
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: ["test/process-leaks.ts", "test/warnings.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    reporters: ["agent", new TestRunReporter(runDirectory)],
    root: projectRoot,
  },
});

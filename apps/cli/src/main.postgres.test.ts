import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testPlatform } from "../../../test/platform.js";
import { additionalDatabase } from "../../../test/postgres.js";
import { testEnvironmentStore } from "../../../test/stores.js";
import { TEST_ENCRYPTION_KEY, temporaryDirectory } from "../../../test/support.js";
import {
  buildTestServer,
  closeServer,
  createBufferIO,
  createDashboardStub,
  listenOnRandomPort,
  OWNER_TOKEN,
  ownerToken,
  repoRoot,
  useCliTestEnvironment,
  withoutProfile,
} from "../test/cli-harness.js";
import { runCli } from "./main.js";

// Program-level behaviour of `swizzle`: parse errors, global flags, profiles and environment pinning.
useCliTestEnvironment();

describe("swizzle CLI program", () => {
  it("names a mistyped command and the command it was close to", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(["valdate", "--json"], io);

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdoutText)).toEqual({
      error: 'Unknown command "valdate" under `swizzle`; did you mean validate?',
      code: "COMMAND_UNKNOWN",
      help: ["Run `swizzle validate --help`", expect.stringContaining("Commands under `swizzle`:")],
    });
    expect(io.stderrText).toBe("");
  });

  it("suggests no command for a short word two edits from one", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(["nope", "--json"], io);

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      error: 'Unknown command "nope" under `swizzle`',
      help: ["Run `swizzle --help`", expect.stringContaining("Commands under `swizzle`:")],
    });
  });

  it("answers a missing argument with the command's usage", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(["schema", "--json"], io);

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdoutText)).toEqual({
      error: "missing required argument 'type'",
      code: "ARGUMENT_MISSING",
      help: [
        "Run `swizzle schema --help`",
        "Usage: swizzle schema [options] <type>. Flags: --api-url, --profile, --environment, --json, --debug (--help always works).",
      ],
    });
    expect(io.stderrText).toBe("");
  });

  it("rejects an unknown flag by name and lists the flags the command takes", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(["runs", "inspect", "run-42", "--compact"], io);

    expect(exitCode).toBe(2);
    expect(io.stdoutText).toBe(
      [
        "error: unknown option '--compact'",
        "code: OPTION_UNKNOWN",
        'help[2]: Run `swizzle runs inspect --help`,"Usage: swizzle runs inspect [options] <runId>. Flags: --full, --api-url, --profile, --environment, --json, --debug (--help always works)."',
        "",
      ].join("\n"),
    );
  });

  it("refuses a run id that is not a UUID before asking the API", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(["runs", "inspect", "does-not-exist", "--json"], io);

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      code: "ARGUMENT_INVALID",
      error: expect.stringContaining("Run ids are UUIDs; `swizzle runs` lists them."),
    });
  });

  it("exits quietly when stdout is closed by a downstream pipe", async () => {
    const io = createBufferIO();
    const brokenPipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const exitCode = await runCli(["schema", "config", "--json"], {
      stderr: (message) => io.stderr(message),
      stdout: () => {
        throw brokenPipe;
      },
    });

    expect(exitCode).toBe(0);
    expect(io.stderrText).toBe("");
  });

  it("refuses a restore without --yes and names the confirmed command", async () => {
    const io = createBufferIO();
    const bundle = await temporaryDirectory("swizzle-cli-unconfirmed-bundle-");

    const exitCode = await runCli(["backup", "restore", "-i", bundle, "--json"], io);

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdoutText)).toEqual({
      error:
        "Refusing without --yes: a restore overwrites the database and artifact storage with the backup's state.",
      code: "CONFIRMATION_REQUIRED",
      help: [`Run \`swizzle backup restore -i ${bundle} --yes\``],
    });
    expect(io.stderrText).toBe("");
  });

  it("refuses to restore a directory that holds no backup", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture");
    const io = createBufferIO();
    const emptyBundle = await temporaryDirectory("swizzle-cli-empty-bundle-");

    const exitCode = await runCli(
      ["backup", "restore", "--input-dir", emptyBundle, "--yes", "--json"],
      io,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      code: "BACKUP_METADATA_MISSING",
      help: [expect.stringContaining("swizzle backup export")],
    });
  });

  it("registers profile commands against an isolated config home", async () => {
    const io = createBufferIO();
    const configHome = await temporaryDirectory("swizzle-cli-profile-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);

    const exitCode = await runCli(
      [
        "profile",
        "add",
        "local",
        "--url",
        "http://localhost:19820",
        "--token-env",
        "SWIZZLE_TOKEN",
        "--json",
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdoutText)).toMatchObject({
      profile: { name: "local", tokenSource: "SWIZZLE_TOKEN", url: "http://localhost:19820" },
      state: "added",
      default: "local",
    });
    expect(await readFile(path.join(configHome, "config.toml"), "utf8")).toContain(
      'token_env = "SWIZZLE_TOKEN"',
    );
    if (process.platform !== "win32") {
      expect((await stat(configHome)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(configHome, "config.toml"))).mode & 0o777).toBe(0o600);
    }
    expect(io.stderrText).toBe("");
  });

  it("reports an environment credential only while its value is available", async () => {
    const configHome = await temporaryDirectory("swizzle-cli-profile-credential-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    vi.stubEnv("REVIEW_UI_TOKEN", "test-device-token");
    const added = createBufferIO();
    expect(
      await runCli(
        [
          "profile",
          "add",
          "staging",
          "--url",
          "http://localhost:19820",
          "--env",
          "staging",
          "--token-env",
          "REVIEW_UI_TOKEN",
          "--json",
        ],
        added,
      ),
    ).toBe(0);
    expect(JSON.parse(added.stdoutText).profile).toMatchObject({
      tokenSource: "REVIEW_UI_TOKEN",
      hasToken: true,
    });
    for (const token of ["test-device-token", "", undefined]) {
      vi.stubEnv("REVIEW_UI_TOKEN", token);
      const listed = createBufferIO();
      expect(await runCli(["profile", "list", "--json"], listed)).toBe(0);
      expect(JSON.parse(listed.stdoutText).profiles).toEqual([
        {
          name: "staging",
          url: "http://localhost:19820",
          environment: "staging",
          project: null,
          tokenSource: "REVIEW_UI_TOKEN",
          hasToken: token === "test-device-token",
        },
      ]);
      expect(listed.stdoutText).not.toContain("test-device-token");
    }
  });

  // Two API servers build every route, and one deploys a fixture: up to 1.9 s of CPU. The budget
  // lets a loaded host give it a tenth of a core.
  it("lets explicit command --api-url override the program-level value and otherwise inherits the global value", async () => {
    const automationDirectory = path.join(repoRoot, "infra/examples/hello-webhook");
    const stateDirectory = await temporaryDirectory("swizzle-cli-global-api-url-");

    const createPlatformApp = async (deployFixtureFirst: boolean) => {
      const database = await additionalDatabase();
      await ownerToken(database);
      const platform = await testPlatform({
        client: database,
        artifactsDirectory: path.join(
          stateDirectory,
          deployFixtureFirst ? "artifacts-b" : "artifacts-a",
        ),
      });
      if (deployFixtureFirst) {
        await platform.deployAutomationToPlatform({ environment: "local", automationDirectory });
      }
      // A dry run asks the API where the deployment would go, which reads the workers it would use.
      const app = await buildTestServer({
        dashboard: createDashboardStub("hello-webhook"),
        platform,
        database,
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      return { address, app };
    };

    const emptyTarget = await createPlatformApp(false);

    const deployedTarget = await createPlatformApp(true);

    try {
      const globalOnlyIo = createBufferIO();
      let exitCode = await runCli(
        ["--api-url", emptyTarget.address, "apply", automationDirectory, "--dry-run", "--json"],
        globalOnlyIo,
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(globalOnlyIo.stdoutText)).toMatchObject({ action: "create", dryRun: true });

      const commandOnlyIo = createBufferIO();
      exitCode = await runCli(
        ["apply", automationDirectory, "--dry-run", "--json", "--api-url", deployedTarget.address],
        commandOnlyIo,
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(commandOnlyIo.stdoutText)).toMatchObject({ action: "noop", dryRun: true });

      const overrideIo = createBufferIO();
      exitCode = await runCli(
        [
          "--api-url",
          emptyTarget.address,
          "apply",
          automationDirectory,
          "--dry-run",
          "--json",
          "--api-url",
          deployedTarget.address,
        ],
        overrideIo,
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(overrideIo.stdoutText)).toMatchObject({ action: "noop", dryRun: true });

      // Forced, the unchanged source updates, and the dry run says why.
      const forcedIo = createBufferIO();
      exitCode = await runCli(
        [
          "apply",
          automationDirectory,
          "--dry-run",
          "--force",
          "--json",
          "--api-url",
          deployedTarget.address,
        ],
        forcedIo,
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(forcedIo.stdoutText)).toMatchObject({
        action: "update",
        changes: "none in the source: --force deploys it again",
        help: [`Run \`swizzle apply ${automationDirectory} -e local --force\` to deploy it`],
      });
    } finally {
      await emptyTarget.app.close();
      await deployedTarget.app.close();
    }
  });

  it("refuses to run an API command when a named profile pins no environment", async () => {
    const configHome = await temporaryDirectory("swizzle-cli-unpinned-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    vi.stubEnv("SWIZZLE_ENVIRONMENT", undefined);

    const platform = await testPlatform();
    const app = await buildTestServer({
      platform,
      environmentStore: await testEnvironmentStore([{ name: "local" }, { name: "prod" }]),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      // A named profile with a URL but no --env is exactly the incident setup.
      let exitCode = await runCli(
        ["profile", "add", "prod", "--url", address, "--token", OWNER_TOKEN, "--json"],
        createBufferIO(),
      );
      expect(exitCode).toBe(0);

      const io = createBufferIO();
      exitCode = await runCli(["secret", "list", "--profile", "prod", "--json"], io);

      // Validation-class failure — the wrong path is now impossible, not warned.
      expect(exitCode).toBe(3);
      const error = JSON.parse(io.stdoutText);
      expect(error).toMatchObject({
        code: "ENVIRONMENT_NOT_PINNED",
        details: { profile: "prod", availableEnvironments: expect.arrayContaining(["prod"]) },
      });
      expect(error.help.join(" ")).toContain("--env");
      expect(error.help.join(" ")).toContain("-e <env>");
      const doctorIo = createBufferIO();
      expect(await runCli(["doctor", "--profile", "prod", "--json"], doctorIo)).toBe(3);
      expect(JSON.parse(doctorIo.stdoutText).code).toBe("ENVIRONMENT_NOT_PINNED");
    } finally {
      await app.close();
    }
  });

  it("runs the same command once the profile pins an environment with -e", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const configHome = await temporaryDirectory("swizzle-cli-pinned-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);

    const platform = await testPlatform();
    const app = await buildTestServer({
      platform,
      environmentStore: await testEnvironmentStore([{ name: "local" }, { name: "prod" }]),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      let exitCode = await runCli(
        ["profile", "add", "prod", "--url", address, "--token", OWNER_TOKEN, "--json"],
        createBufferIO(),
      );
      expect(exitCode).toBe(0);

      const io = createBufferIO();
      exitCode = await runCli(["secret", "list", "--profile", "prod", "-e", "prod", "--json"], io);
      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdoutText)).toEqual({
        secrets: "0 secrets in prod",
        help: ["Run `swizzle secret set <name> --value-env <VAR>` to add one"],
      });
    } finally {
      await app.close();
    }
  });

  it("accepts profile flags before, after, and at both levels with command-level precedence", async () => {
    vi.stubEnv("SWIZZLE_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
    const configHome = await temporaryDirectory("swizzle-cli-profile-position-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);

    const platform = await testPlatform();
    const app = await buildTestServer({
      platform,
      environmentStore: await testEnvironmentStore([{ name: "local" }, { name: "prod" }]),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    try {
      expect(
        await runCli(
          ["profile", "add", "wrong", "--url", "http://127.0.0.1:9", "--env", "local", "--json"],
          createBufferIO(),
        ),
      ).toBe(0);
      expect(
        await runCli(
          [
            "profile",
            "add",
            "prod",
            "--url",
            address,
            "--token",
            OWNER_TOKEN,
            "--env",
            "prod",
            "--json",
          ],
          createBufferIO(),
        ),
      ).toBe(0);

      for (const argv of [
        ["--profile", "prod", "secret", "list", "--json"],
        ["secret", "list", "--profile", "prod", "--json"],
        ["--profile", "wrong", "secret", "list", "--profile", "prod", "--json"],
        ["secret", "--profile", "prod", "list", "--json"],
      ]) {
        const io = createBufferIO();
        const exitCode = await runCli(argv, io);
        expect(exitCode).toBe(0);
        expect(JSON.parse(io.stdoutText)).toEqual({
          secrets: "0 secrets in prod",
          help: ["Run `swizzle secret set <name> --value-env <VAR>` to add one"],
        });
      }
    } finally {
      await app.close();
    }
  });

  it.each([[], ["--api-url", "http://127.0.0.1:1"], ["-e", "staging"]])(
    "requires sign-in before an API command without a profile: %j",
    async (...flags) => {
      await withoutProfile();
      const io = createBufferIO();

      const code = await runCli(["status", "--json", ...flags], io);

      expect(code).toBe(4);
      expect(JSON.parse(io.stdoutText)).toEqual({
        code: "SIGN_IN_REQUIRED",
        error: "No CLI profile is configured. Sign in to use the API.",
        help: [
          "Run `swizzle profile add <name> --url <api-url> --token-env SWIZZLE_TOKEN --env <environment> --default`",
          "Sign in to the dashboard, create an agent token in Settings > Agent access, and set SWIZZLE_TOKEN to that token.",
        ],
      });
      expect(io.stderrText).toBe("");
    },
  );

  it("describes the command tree with nested subcommands for agents", async () => {
    const io = createBufferIO();
    const exitCode = await runCli(["commands", "--json"], io);
    expect(exitCode).toBe(0);

    const tree = JSON.parse(io.stdoutText) as {
      commands: readonly { name: string; subcommands: readonly { name: string }[] }[];
    };
    expect(tree.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["apply", "doctor", "security", "status"]),
    );
    const runs = tree.commands.find((command) => command.name === "runs");
    expect(runs?.subcommands.map((sub) => sub.name)).toEqual(
      expect.arrayContaining(["inspect", "resolve-event"]),
    );
  });

  it("does not warn about CLI/API version mismatch from a source checkout", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ service: "api", status: "ok", version: "9.9.0" }));
        return;
      }
      if (request.url?.startsWith("/secrets")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ environment: "local", secrets: [] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found", message: "not found" }));
    });
    const address = await listenOnRandomPort(server);

    try {
      const io = createBufferIO();
      const exitCode = await runCli(["secret", "list", "--json", "--api-url", address], io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdoutText).warnings).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("applies a global --profile placed before the subcommand", async () => {
    let seenAuthorization: string | undefined;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/dashboard/runs")) {
        seenAuthorization = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ runs: [] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "NOT_FOUND", message: "not found" }));
    });

    const address = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const info = server.address();
        resolve(`http://127.0.0.1:${typeof info === "object" && info ? info.port : 0}`);
      });
    });

    const configHome = await temporaryDirectory("swizzle-cli-global-profile-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    // The default profile points at a dead port — the request only succeeds
    // if the global --profile flag actually selects the stub profile.
    await writeFile(
      path.join(configHome, "config.toml"),
      [
        'default_profile = "dead"',
        "",
        "[profile.dead]",
        'url = "http://127.0.0.1:1"',
        'env = "local"',
        "",
        "[profile.stub]",
        `url = "${address}"`,
        'env = "local"',
        'token = "stub-token"',
        "",
      ].join("\n"),
    );

    try {
      const io = createBufferIO();
      const exitCode = await runCli(["--profile", "stub", "runs", "list", "--json"], io);

      expect(exitCode).toBe(0);
      expect(JSON.parse(io.stdoutText)).toEqual({
        environment: "local",
        runs: "0 runs",
        help: ["Run `swizzle trigger <name>` to start a run"],
      });
      expect(seenAuthorization).toBe("Bearer stub-token");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("refuses a malformed profile token by name and never prints its value", async () => {
    const secret = "swz_tokenpart1234567890";
    const configHome = await temporaryDirectory("swizzle-cli-malformed-token-");
    vi.stubEnv("SWIZZLE_CONFIG_HOME", configHome);
    await writeFile(
      path.join(configHome, "config.toml"),
      [
        'default_profile = "pasted"',
        "",
        "[profile.pasted]",
        'url = "http://127.0.0.1:1"',
        'env = "local"',
        'token_env = "PASTED_TOKEN"',
        "",
      ].join("\n"),
    );
    // A trailing newline, and a value pasted over two lines, which fetch refuses with the
    // whole header in its message.
    for (const pasted of [`${secret}\n`, `${secret}\nsecondline`]) {
      vi.stubEnv("PASTED_TOKEN", pasted);
      const io = createBufferIO();

      const exitCode = await runCli(["runs", "list", "--json"], io);

      expect(exitCode).toBe(4);
      expect(JSON.parse(io.stdoutText)).toEqual({
        error:
          'The token of profile "pasted" in PASTED_TOKEN is malformed: a bearer token holds only letters, digits and - . _ ~ + /.',
        code: "PROFILE_TOKEN_MALFORMED",
        help: [
          "Set PASTED_TOKEN to the token alone, without a line break or space, as Settings > Agent access shows it.",
        ],
      });
      expect(`${io.stdoutText}${io.stderrText}`).not.toMatch(/tokenpart|secondline/);
    }

    // An inline token written over two lines reads back with its opening quote.
    await writeFile(
      path.join(configHome, "config.toml"),
      [
        "[profile.pasted]",
        'url = "http://127.0.0.1:1"',
        'env = "local"',
        `token = "${secret}`,
        '"',
      ].join("\n"),
    );
    const io = createBufferIO();

    expect(await runCli(["--profile", "pasted", "runs", "list", "--json"], io)).toBe(4);
    expect(JSON.parse(io.stdoutText)).toEqual({
      error:
        'The inline token of profile "pasted" is malformed: a bearer token holds only letters, digits and - . _ ~ + /.',
      code: "PROFILE_TOKEN_MALFORMED",
      help: [
        "Run `swizzle profile add pasted --url http://127.0.0.1:1 --token-env SWIZZLE_TOKEN`",
        "Set SWIZZLE_TOKEN to the token alone, without a line break or space, as Settings > Agent access shows it.",
      ],
    });
    expect(`${io.stdoutText}${io.stderrText}`).not.toContain("tokenpart");
  });

  it("refuses to store an inline token that would not survive the config file", async () => {
    const io = createBufferIO();

    const exitCode = await runCli(
      [
        "profile",
        "add",
        "pasted",
        "--url",
        "http://127.0.0.1:1",
        "--token",
        "swz_tokenpart\n",
        "--json",
      ],
      io,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdoutText)).toMatchObject({ code: "PROFILE_TOKEN_MALFORMED" });
    expect(`${io.stdoutText}${io.stderrText}`).not.toContain("tokenpart");
  });
});

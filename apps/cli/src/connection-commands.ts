/**
 * `swizzle connections list | inspect | authorize | test | delete`: OAuth connections over the API.
 * `authorize` answers with the URL a person opens and returns at once, so an agent relays it and
 * checks with `connections inspect`; `--wait` blocks until the person finishes, `--open` launches
 * a browser on this machine. No command prompts.
 */
import { spawn } from "node:child_process";
import type {
  AuthorizeConnectionResponse as AuthorizeResponse,
  ConnectionAuthorizationRequest,
  ConnectionResponse as ConnectionMetadata,
  ConnectionsResponse,
  TestConnectionResponse as TestResponse,
} from "@swizzle/runtime/http-contract";
import type { Command } from "commander";
import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  parseCount,
  type RunHandler,
  removeUnlessAbsent,
  requireYes,
  withExamples,
} from "./command-support.js";
import { resolveCommandEnvironment } from "./environment-guard.js";
import { AgentError, type CliIO, EXIT_CODES, respond } from "./output.js";

/** `--project`: a connection belongs to a project and an environment, as a secret does. */
interface ProjectOption {
  readonly project?: string;
}

const PROJECT_OPTION = [
  "--project <project>",
  "Project, by slug or id (default: the profile's, else Default)",
] as const;

type ConnectionOptions = ApiCommandOptions & ProjectOption;

/** The API URL of a connection route in the command's environment and project. */
async function connectionUrl(pathname: string, options: ConnectionOptions): Promise<string> {
  return buildApiUrl(
    pathname,
    { ...options, environment: await resolveCommandEnvironment(options) },
    options.project === undefined ? undefined : { project: options.project },
  );
}

const projectFlag = (options: ProjectOption) =>
  options.project === undefined ? "" : ` --project ${options.project}`;

interface AuthorizeCommandOptions extends ConnectionOptions {
  readonly provider?: string;
  readonly clientId?: string;
  readonly clientSecretEnv?: string;
  readonly tenant?: string;
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly revokeUrl?: string;
  readonly reuseFrom?: string;
  readonly scopes?: string;
  readonly open?: boolean;
  readonly wait?: boolean;
  readonly timeout: number;
}

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_SECONDS = 300;

/**
 * What a list row and the detail view show of a connection; tokens never leave the API. A list can
 * span projects, and names are unique only within one, so each row names its project.
 */
function connectionRow(connection: ConnectionMetadata) {
  return {
    name: connection.name,
    project: connection.project.slug,
    provider: connection.provider,
    status: connection.authorizationPending
      ? `${connection.status} (authorization pending)`
      : connection.status,
    ...(connection.lastErrorCode !== null ? { lastError: connection.lastErrorCode } : {}),
  };
}

export function registerConnectionCommands(
  program: Command,
  io: CliIO,
  runHandler: RunHandler,
): void {
  const connections = program
    .command("connections")
    .description("Manage OAuth connections (Google, Microsoft, GitHub, ClickUp, generic OAuth2)");
  withExamples(connections, [
    "swizzle connections",
    "swizzle connections authorize google --provider google --client-id <id> --client-secret-env GOOGLE_CLIENT_SECRET",
  ]);

  registerList(connections, io, runHandler);
  registerInspect(connections, io, runHandler);
  registerAuthorize(connections, io, runHandler);
  registerTest(connections, io, runHandler);
  registerDelete(connections, io, runHandler);
}

function registerList(connections: Command, io: CliIO, runHandler: RunHandler): void {
  const list = connections
    .command("list", { isDefault: true })
    .description(
      "List an environment's OAuth connections, of one project or every project you may read",
    )
    .option("--project <project>", "Project, by slug or id (default: every project you may read)");
  withExamples(list, [
    "swizzle connections list",
    "swizzle connections list --project billing -e prod --json",
  ]);
  list.action(async (options: ConnectionOptions) => {
    await runHandler(async () => {
      const response = await apiRequest<ConnectionsResponse>(
        await connectionUrl("/connections", options),
      );
      if (response.connections.length === 0) {
        respond(io, { connections: `0 connections in ${response.environment}` }, [
          `Run \`swizzle connections authorize <name> --provider <provider> --client-id <id> --client-secret-env <VAR>${projectFlag(options)}\` to add one`,
        ]);
        return;
      }
      respond(
        io,
        {
          environment: response.environment,
          count: response.connections.length,
          connections: response.connections.map(connectionRow),
        },
        [
          `Run \`swizzle connections inspect <name> --project <project> -e ${response.environment}\` for scopes, expiry and refresh times`,
        ],
      );
    });
  });
}

function registerInspect(connections: Command, io: CliIO, runHandler: RunHandler): void {
  const inspect = connections
    .command("inspect")
    .description("Show a connection's status, scopes and token times (never its tokens)")
    .argument("<name>", "Connection name")
    .option(...PROJECT_OPTION);
  withExamples(inspect, [
    "swizzle connections inspect google",
    "swizzle connections inspect google --project billing --json",
  ]);
  inspect.action(async (name: string, options: ConnectionOptions) => {
    await runHandler(async () => {
      const connection = await apiRequest<ConnectionMetadata>(
        await connectionUrl(`/connections/${encodeURIComponent(name)}`, options),
      );
      respond(
        io,
        {
          connection: {
            ...connectionRow(connection),
            environment: connection.environment,
            clientId: connection.clientId,
            scopes: connection.scopes.length > 0 ? connection.scopes.join(" ") : "none",
            tokenVersion: connection.tokenVersion,
            accessTokenExpiresAt: connection.accessTokenExpiresAt,
            lastRefreshedAt: connection.lastRefreshedAt,
            lastErrorAt: connection.lastErrorAt,
            updatedAt: connection.updatedAt,
          },
        },
        nextForStatus(connection),
      );
    });
  });
}

/** The flags that name this connection, so a suggested command acts on it and no other. */
const connectionTarget = (connection: ConnectionMetadata) =>
  `${connection.name} --project ${connection.project.slug} -e ${connection.environment}`;

function nextForStatus(connection: ConnectionMetadata): string[] {
  if (connection.status === "active" && !connection.authorizationPending) return [];
  if (connection.authorizationPending)
    return [
      `A person finishes authorizing in the browser; run \`swizzle connections inspect ${connectionTarget(connection)}\` again to check`,
    ];
  return [
    `Run \`swizzle connections authorize ${connectionTarget(connection)}\` to reconnect with its stored client`,
  ];
}

function nextAfterAuthorize(connection: ConnectionMetadata): string[] {
  if (connection.status === "pending" || connection.authorizationPending) {
    return [
      "A person opens authorizationUrl and approves; the provider must allow redirectUri",
      `Run \`swizzle connections inspect ${connectionTarget(connection)}\` to see when it is active`,
    ];
  }
  if (connection.status === "active") {
    return [
      `Run \`swizzle connections test ${connectionTarget(connection)}\` to check it refreshes`,
    ];
  }
  return nextForStatus(connection);
}

function registerAuthorize(connections: Command, io: CliIO, runHandler: RunHandler): void {
  const authorize = connections
    .command("authorize")
    .description(
      "Start the OAuth flow for a connection and answer with the URL a person opens; tokens are stored when they finish",
    )
    .argument("<name>", "Connection name (lowercase kebab-case)")
    .option(
      "--provider <provider>",
      "OAuth provider: google | microsoft | github | clickup | custom-oauth2",
    )
    .option("--client-id <id>", "OAuth client id issued by the provider")
    .option(
      "--client-secret-env <var>",
      "Environment variable that holds the OAuth client secret, so it stays out of process arguments",
    )
    .option("--tenant <tenant>", "Microsoft tenant (common | organizations | consumers | id)")
    .option("--authorize-url <url>", "Authorization endpoint (custom-oauth2 only)")
    .option("--token-url <url>", "Token endpoint (custom-oauth2 only)")
    .option("--revoke-url <url>", "Revocation endpoint (custom-oauth2 only)")
    .option(
      "--reuse-from <connection>",
      "Copy client credentials from a connection you manage in the same project",
    )
    .option("--scopes <scopes>", "Comma-separated OAuth scopes to request")
    .option("--open", "Open the URL in this machine's browser")
    .option("--wait", "Wait until the person finishes; the URL goes to stderr meanwhile")
    .option("--timeout <seconds>", "Seconds --wait waits", parseCount, DEFAULT_POLL_TIMEOUT_SECONDS)
    .option(...PROJECT_OPTION);
  withExamples(authorize, [
    "swizzle connections authorize google --provider google --client-id <id> --client-secret-env GOOGLE_CLIENT_SECRET --scopes https://www.googleapis.com/auth/gmail.readonly",
    "swizzle connections authorize google --project billing --open --wait",
    "swizzle connections authorize crm --reuse-from google --json",
  ]);
  authorize.action(async (name: string, options: AuthorizeCommandOptions) => {
    await runHandler(async () => {
      const started = await apiRequest<AuthorizeResponse>(
        await connectionUrl(`/connections/${encodeURIComponent(name)}/authorize`, options),
        {
          body: JSON.stringify(buildAuthorizeBody(options)),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (options.open === true && !openInBrowser(started.authorizationUrl)) {
        io.stderr("Could not open a browser; open the URL yourself.\n");
      }
      let connection = started.connection;
      let timedOut = false;
      if (options.wait === true) {
        io.stderr(`Open this URL to authorize "${name}": ${started.authorizationUrl}\n`);
        ({ connection, timedOut } = await pollUntilResolved({
          name,
          options,
          timeoutMs: options.timeout * 1_000,
        }));
      }
      respond(
        io,
        {
          connection: connectionRow(connection),
          authorizationUrl: started.authorizationUrl,
          urlExpiresAt: started.expiresAt,
          redirectUri: started.redirectUri,
          ...(timedOut ? { waited: `${options.timeout}s, still pending` } : {}),
        },
        nextAfterAuthorize(connection),
      );
    });
  });
}

function registerTest(connections: Command, io: CliIO, runHandler: RunHandler): void {
  const test = connections
    .command("test")
    .description("Refresh the connection's token now to check it still works")
    .argument("<name>", "Connection name")
    .option(...PROJECT_OPTION);
  withExamples(test, [
    "swizzle connections test google",
    "swizzle connections test google --project billing --json",
  ]);
  test.action(async (name: string, options: ConnectionOptions) => {
    await runHandler(async () => {
      const response = await apiRequest<TestResponse>(
        await connectionUrl(`/connections/${encodeURIComponent(name)}/test`, options),
        { method: "POST" },
      );
      respond(io, {
        connection: connectionRow(response.connection),
        usable: response.refreshed
          ? "yes, refreshed the access token"
          : "yes, its access token is still valid",
        accessTokenExpiresAt: response.accessTokenExpiresAt,
      });
    });
  });
}

function registerDelete(connections: Command, io: CliIO, runHandler: RunHandler): void {
  const remove = connections
    .command("delete")
    .description("Delete a connection and revoke its tokens; a missing one is a no-op")
    .argument("<name>", "Connection name")
    .option("--yes", "Confirm the delete (required)")
    .option(...PROJECT_OPTION);
  withExamples(remove, [
    "swizzle connections delete google --yes",
    "swizzle connections delete google --project billing -e prod --yes --json",
  ]);
  remove.action(async (name: string, options: ConnectionOptions & { readonly yes?: boolean }) => {
    await runHandler(async () => {
      const url = await connectionUrl(`/connections/${encodeURIComponent(name)}`, options);
      const environment = new URL(url).searchParams.get("environment");
      requireYes(
        options.yes,
        `swizzle connections delete ${name}${projectFlag(options)} -e ${environment}`,
        `this deletes connection ${name} in ${environment} and revokes its tokens; automations that use it fail until it is authorized again.`,
      );
      const removed = await removeUnlessAbsent(
        "CONNECTION_NOT_FOUND",
        apiRequest(url, { method: "DELETE" }),
      );
      respond(io, {
        connection: name,
        environment,
        state: removed ? "deleted" : "already absent (no-op)",
      });
    });
  });
}

/**
 * Assemble the authorize request body from the CLI flags: reuse another
 * connection's credentials, provide fresh client id/secret (plus custom-oauth2
 * endpoints), or send neither to reconnect with the stored credentials.
 */
function buildAuthorizeBody(options: AuthorizeCommandOptions): ConnectionAuthorizationRequest {
  const body: {
    -readonly [Key in keyof ConnectionAuthorizationRequest]: ConnectionAuthorizationRequest[Key];
  } = {};
  const scopes = parseScopes(options.scopes);
  if (scopes.length > 0) {
    body.scopes = scopes;
  }

  if (options.reuseFrom) {
    body.reuseFrom = options.reuseFrom;
    return body;
  }

  const hasClientId = options.clientId !== undefined && options.clientId !== "";
  if (hasClientId !== (options.clientSecretEnv !== undefined)) {
    throw new AgentError({
      code: "CONNECTION_CLIENT_CREDENTIALS_INCOMPLETE",
      exitCode: EXIT_CODES.usage,
      hint: "Pass both --client-id and --client-secret-env, or neither to reconnect with stored credentials.",
      message: "Client credentials require both --client-id and --client-secret-env.",
    });
  }

  if (hasClientId && options.clientSecretEnv !== undefined) {
    const clientSecret = process.env[options.clientSecretEnv.trim()];
    if (clientSecret === undefined || clientSecret === "") {
      throw new AgentError({
        code: "CONNECTION_CLIENT_SECRET_ENV_MISSING",
        exitCode: EXIT_CODES.usage,
        hint: `Export ${options.clientSecretEnv} with the client secret, then run the command again.`,
        message: `Environment variable ${options.clientSecretEnv} is missing or empty.`,
      });
    }
    body.clientId = options.clientId;
    body.clientSecret = clientSecret;
    if (options.provider) {
      body.provider = options.provider;
    }
    if (options.provider === "custom-oauth2") {
      if (!options.authorizeUrl || !options.tokenUrl) {
        throw new AgentError({
          code: "CONNECTION_PROVIDER_CONFIG_MISSING",
          exitCode: EXIT_CODES.usage,
          hint: "Pass --authorize-url and --token-url for custom-oauth2 connections.",
          message: "custom-oauth2 requires --authorize-url and --token-url.",
        });
      }
      body.providerConfig = {
        authorizeUrl: options.authorizeUrl,
        tokenUrl: options.tokenUrl,
        ...(options.revokeUrl ? { revokeUrl: options.revokeUrl } : {}),
      };
    } else if (options.provider === "microsoft" && options.tenant) {
      body.providerConfig = { tenant: options.tenant };
    }
  } else if (options.provider) {
    // Provider without credentials only makes sense alongside client id/secret.
    body.provider = options.provider;
  }

  return body;
}

async function pollUntilResolved(input: {
  readonly name: string;
  readonly options: ConnectionOptions;
  readonly timeoutMs: number;
}): Promise<{ readonly connection: ConnectionMetadata; readonly timedOut: boolean }> {
  const deadline = Date.now() + input.timeoutMs;
  const url = await connectionUrl(`/connections/${encodeURIComponent(input.name)}`, input.options);
  let connection = await apiRequest<ConnectionMetadata>(url);

  while (connection.status === "pending" || connection.authorizationPending) {
    if (Date.now() >= deadline) {
      return { connection, timedOut: true };
    }
    await delay(POLL_INTERVAL_MS);
    connection = await apiRequest<ConnectionMetadata>(url);
  }

  return { connection, timedOut: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseScopes(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

// Best-effort browser launch for `--open`. Detaches so the CLI does not wait on it and swallows
// failures; the URL is always in the answer.
function openInBrowser(url: string): boolean {
  try {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

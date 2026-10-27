// The dependency direction of the workspaces and the root's scripts, checked by `just check`.
// Each rule's comment is the message a violation prints. Workspace imports resolve through the
// `swizzle-source` export condition to the source file each package export names, so the
// contract holds on an unbuilt tree.

// Allowlist: the CLI's contract is the HTTP API, so its test harness drives the real api server in process.
const cliTestsDriveTheApi = "^apps/cli/test/cli-harness\\.ts$";

const dashboardIsBrowserOnly =
  "apps/web runs in the browser. db and runtime carry the server's persistence and execution, so the dashboard reaches them through the API.";
// Allowlist: api.ts reads the API's types: db's records and runtime's HTTP contract.
const dashboardTypeSeam = "^apps/web/src/lib/api\\.ts$";
const httpContract = "^packages/runtime/src/http-contract\\.ts$";

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      comment:
        "Modules in a cycle can be neither understood nor tested alone. Move what both sides need into a module both import.",
      from: {},
      to: { circular: true },
    },
    {
      name: "leaf-packages-import-no-workspace",
      severity: "error",
      comment:
        "core, events, config and connections are the dependency-light base every workspace builds on. Importing another workspace makes them carry its weight and invites cycles.",
      from: { path: "^packages/(core|events|config|connections)/" },
      to: { path: "^(apps|packages)/", pathNot: "^packages/$1/" },
    },
    {
      name: "apps-import-no-app",
      severity: "error",
      comment:
        "Apps are separate entry points that ship separately. Code two apps need belongs in a package.",
      from: { path: "^apps/([^/]+)/", pathNot: cliTestsDriveTheApi },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "packages-import-no-app",
      severity: "error",
      comment:
        "Packages are the shared layer under the apps. An import of an app inverts that layering.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "workspaces-meet-at-the-package-root",
      severity: "error",
      comment:
        "Another workspace is reachable only as @swizzle/<name>, listed in package.json (the root's for scripts/). A relative path into its files bypasses its exports and its dependency declaration.",
      from: { path: "^((apps|packages)/[^/]+|scripts)/", pathNot: cliTestsDriveTheApi },
      to: { path: "^(apps|packages)/", pathNot: "^$1/", dependencyTypes: ["local"] },
    },
    {
      name: "dashboard-imports-no-server-package",
      severity: "error",
      comment: `${dashboardIsBrowserOnly} Import the API's types in apps/web/src/lib/api.ts and re-export them from there.`,
      from: { path: "^apps/web/", pathNot: dashboardTypeSeam },
      to: { path: "^packages/(db|runtime)/" },
    },
    {
      name: "dashboard-type-seam-is-type-only",
      severity: "error",
      comment: `${dashboardIsBrowserOnly} api.ts may import their types, which the build erases, and nothing else.`,
      from: { path: dashboardTypeSeam },
      to: { path: "^packages/(db|runtime)/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "dashboard-type-seam-reads-the-contract",
      severity: "error",
      comment:
        "The dashboard type-checks everything api.ts reaches. The @swizzle/db root and @swizzle/runtime/http-contract name records only; @swizzle/db/postgres and the other runtime entries bring drizzle, pg and the platform services, which double the check's time.",
      from: { path: dashboardTypeSeam },
      to: {
        path: ["^packages/db/src/postgres\\.ts$", "^packages/runtime/"],
        pathNot: httpContract,
      },
    },
    {
      name: "http-contract-names-records-only",
      severity: "error",
      comment:
        "@swizzle/runtime/http-contract is what the dashboard type-checks alongside its own code, so it reaches records only: the @swizzle/db root and src/platform-records.ts. Move the record a response needs into platform-records.ts instead of importing the module that builds it.",
      from: { path: httpContract },
      to: {
        reachable: true,
        path: [
          "^packages/runtime/src/",
          "^packages/db/src/postgres\\.ts$",
          "node_modules/(bullmq|ioredis|drizzle-orm|pg|@aws-sdk)/",
        ],
        pathNot: "^packages/runtime/src/(http-contract|platform-records|storage/types)\\.ts$",
      },
    },
    {
      name: "dashboard-imports-config-browser-entry",
      severity: "error",
      comment:
        "apps/web runs in the browser. Import @swizzle/config/browser, whose helpers run there. The root entry carries the config parsers, which need node:path, yaml, zod and ajv.",
      from: { path: "^apps/web/" },
      to: { path: "^packages/config/src/index\\.ts$" },
    },
    {
      name: "config-browser-entry-stays-in-the-package",
      severity: "error",
      comment:
        "@swizzle/config/browser is the part of the config package the dashboard bundles. Everything it reaches must run in a browser, so it reaches only the package's own modules, never node:*, yaml, zod or ajv.",
      from: { path: "^packages/config/src/browser\\.ts$" },
      to: { reachable: true, pathNot: "^packages/config/src/" },
    },
    {
      name: "cheap-entries-load-no-service-client",
      severity: "error",
      comment:
        "@swizzle/db and @swizzle/runtime are the entries the CLI and every test load, so they stay free of the Valkey and Postgres clients, which take seconds to import. Put code that needs them behind @swizzle/db/postgres or @swizzle/runtime/platform.",
      from: { path: "^packages/(db|runtime)/src/index\\.ts$" },
      to: { path: "node_modules/(bullmq|ioredis|drizzle-orm|pg)/", reachable: true },
    },
    {
      name: "llm-gateway-loads-only-itself",
      severity: "error",
      comment:
        "The local LLM gateway is a listener the sandbox can reach. Its entry, @swizzle/runtime/local-llm-gateway, loads node built-ins and the cheap @swizzle/config/browser constants only, so the process holds no database, queue or credential code.",
      from: { path: "^packages/runtime/src/local-llm-gateway\\.ts$" },
      to: {
        reachable: true,
        path: ["node_modules/", "^packages/(?!config/src/|runtime/src/local-llm(-gateway)?\\.ts$)"],
        pathNot:
          "^packages/config/src/(browser|connection-name|flow-map|intervals|worker-services)\\.ts$",
      },
    },
    {
      name: "heavy-libraries-load-on-first-use",
      severity: "error",
      comment:
        "The AWS SDK, the OpenTelemetry SDK, undici and the Postgres stores take longer to import than the rest of the runtime. Import them with `await import()` where the client is created, so only the code that uses one pays for it.",
      from: { path: "^packages/(core|runtime)/src/", pathNot: "\\.test\\.ts$" },
      to: {
        path: [
          "node_modules/(@aws-sdk/|@opentelemetry/(?!api/)|@fastify/otel/|undici/)",
          "^packages/db/src/postgres\\.ts$",
        ],
        dependencyTypesNot: ["dynamic-import", "type-only", "type-import"],
      },
    },
    {
      name: "workspace-imports-resolve-to-source",
      severity: "error",
      comment:
        'A workspace import resolved to a build output or not at all, so this contract cannot see its source. List the package in the importer\'s package.json dependencies, and give each of its exports a "swizzle-source" condition pointing at the source file, such as ./src/index.ts.',
      from: {},
      to: { path: "^(@swizzle/|packages/[^/]+/dist/)" },
    },
  ],
  options: {
    // Build outputs stay visible as import targets, so an import that resolves into one is red.
    doNotFollow: { path: ["node_modules", "(^|/)dist/"] },
    // `import type` couples modules as much as a value import does.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["swizzle-source", "import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};

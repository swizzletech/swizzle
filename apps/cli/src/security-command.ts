import type { SecurityAuditResponse } from "@swizzle/runtime/http-contract";
import type { Command } from "commander";

import { apiRequest } from "./api.js";
import {
  type ApiCommandOptions,
  buildApiUrl,
  type RunHandler,
  showsSubcommands,
  withExamples,
} from "./command-support.js";
import { type CliIO, EXIT_CODES, HandledCliError, respond } from "./output.js";

/** `swizzle security audit`: the instance's public-deployment checks; exit 1 when any needs attention. */
export function registerSecurityCommand(program: Command, io: CliIO, runHandler: RunHandler): void {
  const security = program.command("security").description("Inspect instance security posture");
  showsSubcommands(security);
  withExamples(security, ["swizzle security audit", "swizzle security audit --json"]);

  const audit = security
    .command("audit")
    .description(
      "Check public-deployment security controls (instance admins); exits 1 when one needs attention",
    )
    .option("--all", "List the passing checks too");
  withExamples(audit, [
    "swizzle security audit",
    "swizzle security audit --all --profile prod --json",
  ]);
  audit.action(async (options: ApiCommandOptions & { readonly all?: boolean }) => {
    await runHandler(async () => {
      const { all, environment: _environment, ...target } = options;
      const report = await apiRequest<SecurityAuditResponse>(
        buildApiUrl("/security/audit", target),
        {
          method: "POST",
        },
      );
      const failing = report.checks.filter((check) => check.level !== "pass");
      const listed = all === true ? report.checks : failing;
      let help: string[] = [];
      if (failing.length > 0) {
        help = [
          "Fix each critical and warning check as its detail says, then run `swizzle security audit` again",
        ];
      } else if (all !== true) {
        help = ["Run `swizzle security audit --all` to list the passing checks"];
      }
      respond(
        io,
        {
          status: report.status,
          summary: `${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.critical} critical`,
          checkedAt: report.checkedAt,
          checks:
            listed.length === 0
              ? "none need attention"
              : listed.map((check) => ({
                  level: check.level,
                  id: check.id,
                  title: check.title,
                  detail: check.detail,
                })),
        },
        help,
      );
      if (report.status === "attention") throw new HandledCliError(EXIT_CODES.generic);
    });
  });
}

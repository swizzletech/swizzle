/**
 * `node dist/recover-owner.js <email>` in the API container: restores a locked-out owner's access
 * (HostAuth.recoverOwner). It runs only from a shell on the host (`just recover-owner <email>`),
 * no route calls it, and the instance audit records it with the actor `host` before it changes
 * anything. It prints the one reset link it mints and no other secret.
 *
 * stdout: `owner`, `reset-link` and `expires`, or `error` with the active owners' addresses.
 * Exit 0 recovered, 1 no active owner has the address or the recovery failed, 2 usage.
 */
import { assertSecretEncryptionKeyIsConfigured, NO_AUDIT_TARGET } from "@swizzle/db";
import { createPostgresAuditStore, createPostgresHostAuth } from "@swizzle/db/postgres";

import { dashboardOrigin } from "./http-shared.js";

const HELP = [
  "usage: node dist/recover-owner.js <owner email>",
  "description: Turns the owner's two-factor sign-in off, signs them out everywhere and prints a",
  "  link that sets a new password once, within the hour. The instance audit records it.",
  "help: From the checkout on the host, run `just recover-owner <owner email>`.",
].join("\n");

async function main(args: readonly string[]): Promise<number> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    print(HELP);
    return 0;
  }
  const email = args[0];
  if (args.length !== 1 || email === undefined || email.startsWith("-")) {
    print(
      `error: expected one owner email address, got ${args.length === 0 ? "none" : args.join(" ")}\n${HELP}`,
    );
    return 2;
  }
  const origin = dashboardOrigin();
  if (origin === null) {
    print(
      "error: SWIZZLE_DASHBOARD_ORIGIN is not an http or https URL, so there is no page to open the link\n" +
        "help: Set SWIZZLE_DASHBOARD_ORIGIN in .env to the dashboard's address and run `just stack`.",
    );
    return 1;
  }
  assertSecretEncryptionKeyIsConfigured();

  const auth = createPostgresHostAuth({ dashboardOrigin: origin });
  const audit = createPostgresAuditStore();
  try {
    const eventId = await audit.begin({
      action: "recover-owner",
      actor: { kind: "host" },
      details: null,
      params: { email },
      privileged: false,
      requestId: "host",
      target: NO_AUDIT_TARGET,
    });
    const recovery = await auth.recoverOwner(email).catch(async (error: unknown) => {
      await audit.finish(eventId, 500);
      throw error;
    });
    await audit.finish(eventId, recovery.kind === "recovered" ? 200 : 404);
    if (recovery.kind === "not-an-owner") {
      print(
        [
          `error: no active owner has the address ${email}`,
          `owners[${recovery.owners.length}]: ${recovery.owners.join(",")}`,
          "help: Run `just recover-owner <owner email>` with one of these addresses.",
        ].join("\n"),
      );
      return 1;
    }
    print(
      [
        `owner: ${recovery.email}`,
        `reset-link: ${recovery.link.url}`,
        `expires: ${recovery.link.expiresAt}`,
        "done: Two-factor sign-in is off and every session of this owner ended.",
        "help: Open the link to choose a new password; it works once and also revokes the owner's",
        "  agent tokens. Then sign in and turn two-factor sign-in on again under Settings.",
      ].join("\n"),
    );
    return 0;
  } finally {
    await Promise.all([auth.close(), audit.close()]);
  }
}

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  print(
    "error: the recovery failed\nhelp: Read stderr above, fix the cause and run the command again.",
  );
  return 1;
});

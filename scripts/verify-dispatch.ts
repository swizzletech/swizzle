import { writeSync } from "node:fs";
import { withVerificationDatabase } from "./verification-database.js";
import { verifyAdmission } from "./verify-dispatch-admission.js";
import { verifyChecks } from "./verify-dispatch-checks.js";
import { verifyClaims } from "./verify-dispatch-claims.js";
import { withDispatchFixture } from "./verify-dispatch-fixture.js";
import { verifyLeases } from "./verify-dispatch-leases.js";
import { verifyRestarts } from "./verify-dispatch-restarts.js";
import { verifyRunImages } from "./verify-run-images.js";

process.env.SWIZZLE_ENCRYPTION_KEY ??= "12345678901234567890123456789012";
let scenario = "dispatch database setup";
const watchdog = setTimeout(() => {
  writeSync(process.stderr.fd, `verify-dispatch exceeded 10 minutes during ${scenario}.\n`);
  process.exit(1);
}, 10 * 60_000);
try {
  for (const verify of [
    verifyClaims,
    verifyLeases,
    verifyAdmission,
    verifyRestarts,
    verifyChecks,
  ]) {
    scenario = `${verify.name} database and API setup`;
    await withVerificationDatabase((client) =>
      withDispatchFixture(client, (fixture) =>
        verify(fixture, (current) => {
          scenario = current;
        }),
      ),
    );
  }
  scenario = "durable run images";
  await withVerificationDatabase(verifyRunImages);
} finally {
  clearTimeout(watchdog);
}

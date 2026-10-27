const declaredSecret = process.env.DECLARED_SECRET;
// biome-ignore lint/complexity/useLiteralKeys: Fixture covers static bracket env references.
const declaredVar = process.env["DECLARED_VAR"];
const platformVar = process.env.SWIZZLE_RUN_ID;
const missingOne = process.env.OWN_EMAILS;
// biome-ignore lint/complexity/useLiteralKeys: Fixture covers static bracket env references.
const missingTwo = process.env["MAX_ITEMS"];
const dynamic = process.env["PREFIX_" + "NAME"];

process.stdout.write(
  JSON.stringify({
    declaredSecret,
    declaredVar,
    platformVar,
    missingOne,
    missingTwo,
    dynamic,
  }),
);

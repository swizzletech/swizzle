// Fixture: flow.mermaid names `parse` and `notify`; the code runs `parse` and `review`.
// Only `swizzle validate` scans it; the helpers are stand-ins, so nothing has to resolve.
const runStep = async (_key, fn) => fn();
const requestApproval = async () => ({ approved: true });

const parsed = await runStep("parse", () => ({ ok: true }));
await requestApproval("review", { details: parsed });
process.stdout.write(JSON.stringify(parsed));

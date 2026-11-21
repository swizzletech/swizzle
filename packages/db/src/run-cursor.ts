export interface RunCursor {
  readonly queuedAt: string;
  readonly runId: string;
}

const QUEUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(`${cursor.queuedAt}|${cursor.runId}`).toString("base64url");
}

export function decodeRunCursor(text: string): RunCursor | null {
  const [queuedAt, runId, ...rest] = Buffer.from(text, "base64url").toString().split("|");
  if (queuedAt === undefined || runId === undefined || rest.length > 0) return null;
  return QUEUED_AT.test(queuedAt) && RUN_ID.test(runId) ? { queuedAt, runId } : null;
}

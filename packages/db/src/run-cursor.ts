// Where one page of the run list ends. A run's queue time never changes after it is stored, so the
// pair (queue time, run id) marks one place in the list even while new runs arrive above it.
// The time keeps Postgres's microseconds: a Date holds milliseconds, and runs queued within one
// millisecond would repeat or go missing at a page boundary.

export interface RunCursor {
  /** UTC with six fractional digits, as Postgres stores it. */
  readonly queuedAt: string;
  readonly runId: string;
}

const QUEUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(`${cursor.queuedAt}|${cursor.runId}`).toString("base64url");
}

/** The cursor a client sent back, or null when it is not one this API handed out. */
export function decodeRunCursor(text: string): RunCursor | null {
  const [queuedAt, runId, ...rest] = Buffer.from(text, "base64url").toString().split("|");
  if (queuedAt === undefined || runId === undefined || rest.length > 0) return null;
  return QUEUED_AT.test(queuedAt) && RUN_ID.test(runId) ? { queuedAt, runId } : null;
}

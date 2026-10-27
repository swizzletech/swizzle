import type { RunLogsResponse as PollLogsResponse } from "@swizzle/runtime/http-contract";
import { apiRequest } from "./api.js";
import { type ApiCommandOptions, buildApiUrl } from "./command-support.js";
import { type CliIO, outputFormat } from "./output.js";

const POLL_INTERVAL_MS = 2_000;

/**
 * Prints a run's log (its stderr) on stdout as it arrives, until the run ends. Its stdout is the
 * result, which the caller prints afterwards. Under `--json` each chunk is one `{"log":…}` line.
 */
export async function followRunLogs(
  io: CliIO,
  options: ApiCommandOptions & { readonly environment: string },
  runId: string,
): Promise<void> {
  let cursor = "0:0";
  let endsWithNewline = true;
  for (;;) {
    const batch = await apiRequest<PollLogsResponse>(
      buildApiUrl(`/runs/${encodeURIComponent(runId)}/logs`, options, { after: cursor }),
    );
    cursor = batch.cursor;
    for (const chunk of batch.chunks) {
      if (chunk.stream !== "stderr" || chunk.chunk.length === 0) continue;
      if (outputFormat() === "json") {
        io.stdout(`${JSON.stringify({ log: chunk.chunk })}\n`);
      } else {
        io.stdout(chunk.chunk);
        endsWithNewline = chunk.chunk.endsWith("\n");
      }
    }
    if (batch.terminal) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  if (!endsWithNewline) io.stdout("\n");
}

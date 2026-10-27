// The run's live stream: `GET /runs/:id/logs/stream` relays the executions' stderr so far, then every
// chunk, step and status event the worker publishes while the run is open.

import { useEffect, useRef, useState } from "react";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

interface RunLogChunk {
  readonly chunk: string;
  readonly executionNumber: number;
  readonly stream: "stderr" | "stdout";
  readonly timestamp: string;
}

/** A step of the run started or finished, as the worker reported it. */
export interface RunStepEvent {
  /** The retry attempt the reporting execution spends. */
  readonly attempt: number;
  readonly executionNumber: number;
  readonly key: string;
  readonly status: "started" | "done";
  readonly timestamp: string;
}

export interface RunLogStreamState {
  readonly chunks: readonly RunLogChunk[];
  readonly error: string | null;
  readonly status: string | null;
  /** Step events in arrival order, from the moment the stream opened. */
  readonly steps: readonly RunStepEvent[];
  readonly streaming: boolean;
}

export function useRunLogStream(runId: string, enabled: boolean): RunLogStreamState {
  const [chunks, setChunks] = useState<RunLogChunk[]>([]);
  // Kept with the run they belong to, so another run's events never read as this run's.
  const [steps, setSteps] = useState<{ runId: string; events: RunStepEvent[] }>({
    events: [],
    runId,
  });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      abortRef.current = null;
      setStreaming(false);
      return;
    }

    // The stream replays the executions' stderr so far, so a reconnect starts from nothing.
    setChunks([]);
    setSteps({ events: [], runId });
    setStatus(null);
    setError(null);

    const abortController = new AbortController();
    abortRef.current = abortController;
    setStreaming(true);

    void readServerSentEvents({
      onChunk: (chunk) => setChunks((current) => [...current, chunk]),
      onError: setError,
      onStatus: setStatus,
      onStep: (step) =>
        setSteps((current) =>
          current.runId === runId ? { ...current, events: [...current.events, step] } : current,
        ),
      runId,
      signal: abortController.signal,
    }).finally(() => {
      if (abortRef.current === abortController) {
        abortRef.current = null;
        setStreaming(false);
      }
    });

    return () => {
      abortController.abort();
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
      setStreaming(false);
    };
  }, [runId, enabled]);

  return { chunks, error, status, steps: steps.runId === runId ? steps.events : [], streaming };
}

interface StreamHandlers {
  readonly onChunk: (chunk: RunLogChunk) => void;
  readonly onError: (message: string) => void;
  readonly onStatus: (status: string) => void;
  readonly onStep: (step: RunStepEvent) => void;
}

async function readServerSentEvents(
  input: StreamHandlers & {
    readonly runId: string;
    readonly signal: AbortSignal;
  },
) {
  const headers = new Headers({ Accept: "text/event-stream" });

  try {
    const response = await fetch(
      `${API_BASE_URL}/runs/${encodeURIComponent(input.runId)}/logs/stream`,
      {
        credentials: "include",
        headers,
        signal: input.signal,
      },
    );
    if (!response.ok) {
      input.onError(`Log stream request failed with status ${response.status}.`);
      return;
    }
    if (!response.body) {
      input.onError("Log stream response did not include a readable body.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = consumeBufferedEvents(buffer, input);
      if (done) break;
    }
    consumeBufferedEvents(`${buffer}\n\n`, input);
  } catch (streamError) {
    if (input.signal.aborted) return;
    input.onError(streamError instanceof Error ? streamError.message : "Log stream failed.");
  }
}

function consumeBufferedEvents(buffer: string, handlers: StreamHandlers): string {
  let remainder = buffer;
  while (true) {
    const separatorIndex = remainder.indexOf("\n\n");
    if (separatorIndex < 0) return remainder;
    const rawEvent = remainder.slice(0, separatorIndex);
    remainder = remainder.slice(separatorIndex + 2);
    handleServerSentEvent(rawEvent, handlers);
  }
}

function handleServerSentEvent(rawEvent: string, handlers: StreamHandlers) {
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");

  try {
    if (eventName === "chunk") {
      handlers.onChunk(JSON.parse(data) as RunLogChunk);
      return;
    }
    if (eventName === "step") {
      handlers.onStep(JSON.parse(data) as RunStepEvent);
      return;
    }
    if (eventName === "status") {
      const parsed = JSON.parse(data) as {
        status: string;
        terminal: boolean;
      };
      handlers.onStatus(parsed.status);
    }
  } catch (parseError) {
    handlers.onError(
      parseError instanceof Error ? parseError.message : "Failed to parse log event.",
    );
  }
}

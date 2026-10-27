import type { Readable } from "node:stream";
import { BoundedOutput } from "./bounded-output.js";

type StreamName = "stdout" | "stderr";
type ChunkCallback = (chunk: string) => void | Promise<void>;
type StopReason =
  | { readonly kind: "limit"; readonly stream: StreamName }
  | { readonly kind: "callback-failed" };

type OutputPumpOptions = {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly onStderrChunk?: ChunkCallback | undefined;
  /** Runs stop at the limit. Docker control commands bound capture but deliver all bytes. */
  readonly limitPolicy: "stop" | "capture";
  readonly onStop: (reason: StopReason) => void;
} & (
  | { readonly onStdoutChunk?: ChunkCallback | undefined; readonly onStdoutBytes?: never }
  | { readonly onStdoutBytes: (chunk: Buffer) => void; readonly onStdoutChunk?: never }
);

/** Owns bounded capture and ordered delivery across both pipes of a subprocess. */
export class OutputPump {
  private readonly captures: Record<StreamName, BoundedOutput>;
  private callbacks: Promise<void> = Promise.resolve();
  private failure: { readonly error: unknown } | undefined;
  private stopped = false;
  private exceededStream: StreamName | null = null;

  constructor(private readonly options: OutputPumpOptions) {
    this.captures = {
      stdout: new BoundedOutput(options.stdoutLimitBytes),
      stderr: new BoundedOutput(options.stderrLimitBytes),
    };
    const onStdoutBytes = options.onStdoutBytes;
    if (onStdoutBytes !== undefined) {
      options.stdout.on("data", (chunk: Buffer) => {
        this.deliver(options.stdout, () => onStdoutBytes(chunk));
      });
    } else {
      this.readText("stdout", options.onStdoutChunk);
    }
    this.readText("stderr", options.onStderrChunk);
  }

  get stdout(): string {
    return this.captures.stdout.value;
  }
  get stderr(): string {
    return this.captures.stderr.value;
  }
  get exceeded(): StreamName | null {
    return this.exceededStream;
  }

  stop(): void {
    this.stopped = true;
  }

  async finished(): Promise<void> {
    await this.callbacks;
    if (this.failure !== undefined) throw this.failure.error;
  }

  private readText(name: StreamName, callback: ChunkCallback | undefined): void {
    const stream = this.options[name];
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (this.stopped) return;
      const output = this.captures[name];
      const accepted = output.append(chunk);
      const delivered = this.options.limitPolicy === "capture" ? chunk : accepted;
      if (callback !== undefined && delivered) this.deliver(stream, () => callback(delivered));
      if (output.exceeded && this.exceededStream === null) {
        this.exceededStream = name;
        if (this.options.limitPolicy === "stop")
          this.options.onStop({ kind: "limit", stream: name });
      }
    });
  }

  private deliver(stream: Readable, callback: () => void | Promise<void>): void {
    if (this.stopped || this.failure !== undefined) return;
    stream.pause();
    this.callbacks = this.callbacks
      .then(async () => {
        if (this.failure === undefined) await callback();
      })
      .catch((error: unknown) => {
        this.failure = { error };
        this.options.onStop({ kind: "callback-failed" });
      })
      .finally(() => stream.resume());
  }
}

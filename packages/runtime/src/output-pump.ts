import type { Readable } from "node:stream";
import { BoundedOutput } from "./bounded-output.js";

type StreamName = "stdout" | "stderr";
type ChunkCallback = (chunk: string) => void | Promise<void>;
export type StdoutOutput =
  | { readonly kind: "text"; readonly onChunk?: ChunkCallback | undefined }
  | { readonly kind: "bytes"; readonly onChunk: (chunk: Buffer) => "stop" | undefined };

type StopReason =
  | { readonly kind: "limit"; readonly stream: StreamName }
  | { readonly kind: "requested" }
  | { readonly kind: "callback-failed" };

interface OutputPumpOptions {
  readonly stdout: StdoutOutput;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly onStderrChunk?: ChunkCallback | undefined;
  readonly limitPolicy: "stop" | "capture";
  readonly onStop: (reason: StopReason) => void;
}

export class OutputPump {
  private readonly captures: Record<StreamName, BoundedOutput>;
  private callbacks: Promise<void> = Promise.resolve();
  private failure: { readonly error: unknown } | undefined;
  private stopped: "external" | "requested" | null = null;
  private exceededStream: StreamName | null = null;

  constructor(
    private readonly streams: Readonly<Record<StreamName, Readable>>,
    private readonly options: OutputPumpOptions,
  ) {
    this.captures = {
      stdout: new BoundedOutput(options.stdoutLimitBytes),
      stderr: new BoundedOutput(options.stderrLimitBytes),
    };
    const stdout = options.stdout;
    if (stdout.kind === "bytes") {
      streams.stdout.on("data", (chunk: Buffer) => {
        this.deliver(streams.stdout, () => {
          if (stdout.onChunk(chunk) === "stop") {
            this.stopped = "requested";
            options.onStop({ kind: "requested" });
          }
        });
      });
    } else {
      this.readText("stdout", stdout.onChunk);
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
  get stoppedByRequest(): boolean {
    return this.stopped === "requested";
  }

  stop(): void {
    this.stopped ??= "external";
  }

  async finished(): Promise<void> {
    await this.callbacks;
    if (this.failure !== undefined) throw this.failure.error;
  }

  private readText(name: StreamName, callback: ChunkCallback | undefined): void {
    const stream = this.streams[name];
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (this.stopped !== null) return;
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
    if (this.stopped !== null || this.failure !== undefined) return;
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

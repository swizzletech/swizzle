import { createRequire } from "node:module";

export interface FileSettings {
  readonly file: string;
  readonly frequency: string;
  readonly limit: { readonly count: number };
  readonly size: string;
}

export type Request =
  | { readonly kind: "open"; readonly settings: FileSettings }
  | { readonly kind: "write"; readonly data: string };

export type Reply =
  | { readonly kind: "written" }
  | { readonly kind: "error"; readonly message: string };

interface Destination {
  on(event: "error", listener: (error: Error) => void): void;
  write(data: string): void;
  flushSync(): void;
}

function runWriter(): void {
  const require = createRequire(import.meta.url);
  const open: (settings: FileSettings & { sync: true; mkdir: true }) => Promise<Destination> =
    require("pino-roll");
  let sink: Destination | undefined;
  const reply = (message: Reply) => process.send?.(message);
  const fail = (error: unknown) =>
    reply({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });

  process.on("message", (message: Request) => {
    void (async () => {
      if (message.kind === "open") {
        sink = await open({ ...message.settings, sync: true, mkdir: true });
        sink.on("error", fail);
      } else {
        if (sink === undefined) throw new Error("File log sink is not open");
        sink.write(message.data);
        sink.flushSync();
      }
      reply({ kind: "written" });
    })().catch(fail);
  });
  process.on("disconnect", () => process.exit());
}

if (import.meta.main) runWriter();

import { renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";

export function publishDevPort(server: Server, file: string | undefined): void {
  if (file === undefined) return;
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`Cannot publish the development port to ${file}: no TCP port is bound.`);
  }
  const draft = `${file}.${process.pid}`;
  writeFileSync(draft, `${process.pid} ${address.port}\n`, { mode: 0o600 });
  renameSync(draft, file);
}

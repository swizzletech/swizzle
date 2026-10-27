// A mail server that accepts every message and keeps it, for tests and the dev stack: point
// SWIZZLE_SMTP_URL at smtp://127.0.0.1:<port> and read `messages`. It offers no STARTTLS, which
// the Swizzle mailer accepts only from a loopback address, and it accepts any AUTH PLAIN.
// Commands it does not implement get 502, as a real server answers them.

import { createServer, type Server } from "node:net";

export interface SunkMail {
  /** The credentials of AUTH PLAIN on this connection, null without AUTH. */
  readonly auth: { readonly user: string; readonly password: string } | null;
  readonly from: string;
  readonly to: readonly string[];
  /** The header lines as the client sent them, folded lines included. */
  readonly headers: readonly string[];
  readonly subject: string;
  readonly text: string;
}

export interface MailSink {
  readonly url: string;
  readonly messages: SunkMail[];
  close(): Promise<void>;
}

export async function startMailSink(
  options: { readonly port?: number; readonly onMessage?: (mail: SunkMail) => void } = {},
): Promise<MailSink> {
  const messages: SunkMail[] = [];
  const server: Server = createServer((socket) => {
    let buffered = "";
    let auth: SunkMail["auth"] = null;
    let from = "";
    let to: string[] = [];
    let data: string[] | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 swizzle-mail-sink");
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (let end = buffered.indexOf("\r\n"); end !== -1; end = buffered.indexOf("\r\n")) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (data !== null) {
          if (line !== ".") {
            data.push(line.startsWith("..") ? line.slice(1) : line);
            continue;
          }
          const mail = parse(auth, from, to, data);
          messages.push(mail);
          options.onMessage?.(mail);
          data = null;
          say("250 queued");
          continue;
        }
        const verb = line.split(" ")[0]?.toUpperCase() ?? "";
        if (verb === "EHLO") say("250-swizzle-mail-sink\r\n250 AUTH PLAIN");
        else if (verb === "AUTH") {
          const [user = "", password = ""] = Buffer.from(line.split(" ")[2] ?? "", "base64")
            .toString("utf8")
            .split("\u0000")
            .slice(1);
          auth = { password, user };
          say("235 accepted");
        } else if (verb === "MAIL") {
          from = address(line);
          to = [];
          say("250 sender");
        } else if (verb === "RCPT") {
          to.push(address(line));
          say("250 recipient");
        } else if (verb === "DATA") {
          data = [];
          say("354 go ahead");
        } else if (verb === "QUIT") {
          say("221 bye");
          socket.end();
        } else if (verb === "RSET" || verb === "NOOP") say("250 ok");
        else say("502 not implemented");
      }
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as { port: number };
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
    messages,
    url: `smtp://127.0.0.1:${port}`,
  };
}

function address(line: string): string {
  return /<([^>]*)>/u.exec(line)?.[1] ?? "";
}

function parse(
  auth: SunkMail["auth"],
  from: string,
  to: readonly string[],
  lines: readonly string[],
): SunkMail {
  const blank = lines.indexOf("");
  const headers = lines.slice(0, blank);
  // A line that starts with white space continues the header above it.
  const unfolded = headers.join("\r\n").split(/\r\n(?![ \t])/u);
  const header = (name: string) =>
    unfolded
      .find((line) => line.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .replace(/\r\n[ \t]+/gu, " ")
      .trim() ?? "";
  // White space between two encoded words belongs to neither (RFC 2047, section 6.2).
  const subject = header("subject")
    .replace(/\?=\s+=\?/gu, "?==?")
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/giu, (_, encoding: string, word: string) =>
      (encoding.toUpperCase() === "B"
        ? Buffer.from(word, "base64")
        : quotedPrintable(word.replaceAll("_", " "))
      ).toString("utf8"),
    );
  const text = decodeBody(header("content-transfer-encoding"), lines.slice(blank + 1));
  return { auth, from, headers, subject, text: text.replace(/\r\n/gu, "\n"), to };
}

function decodeBody(encoding: string, body: readonly string[]): string {
  switch (encoding.toLowerCase()) {
    case "base64":
      return Buffer.from(body.join(""), "base64").toString("utf8");
    case "quoted-printable":
      return quotedPrintable(body.join("\r\n")).toString("utf8");
    default:
      return body.join("\n");
  }
}

/** The bytes of quoted-printable text: `=` ends a soft line break or starts a hex byte. */
function quotedPrintable(text: string): Buffer {
  return Buffer.from(
    text
      .replace(/=\r\n/gu, "")
      .replace(/=([0-9A-F]{2})/giu, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
    "latin1",
  );
}

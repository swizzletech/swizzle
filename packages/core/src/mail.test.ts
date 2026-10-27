import { connect, createServer } from "node:net";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { startMailSink } from "../../../test/mail-sink.js";
import { createSmtpMailer, readMailSettings } from "./mail.js";

/** An HTTP proxy that answers every CONNECT with 200 and tunnels to `port`, whatever the target. */
async function connectProxy(port: number) {
  const targets: string[] = [];
  const server = createServer((client) => {
    client.once("data", (head) => {
      targets.push(head.toString("latin1").split(" ")[1] ?? "");
      const upstream = connect({ host: "127.0.0.1", port }, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { targets, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const sinks: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

describe("createSmtpMailer", () => {
  it("delivers a message, with its UTF-8 subject and body, through the egress proxy", async () => {
    // A line on its own with a dot ends DATA, and a link longer than a mail line must arrive whole.
    const text = `Hallo,\n.\nein Punkt allein beendet die Nachricht nicht: https://swizzle.example.com/invitation#token=swzi_${"x".repeat(64)}`;
    const sink = await startMailSink();
    sinks.push(sink);
    const proxy = await connectProxy(Number(new URL(sink.url).port));
    const settings = readMailSettings({
      SWIZZLE_CONTROL_EGRESS_PROXY: proxy.url,
      SWIZZLE_MAIL_FROM: "Swizzle <ops@example.com>",
      SWIZZLE_SMTP_URL: `smtp://ops:p%40ss@localhost:${new URL(sink.url).port}`,
    });
    if (settings === null) throw new Error("The settings were not read.");

    await createSmtpMailer(settings).send({
      subject: "Einladung für Jürgen",
      text,
      to: "juergen@example.com",
    });

    expect(proxy.targets).toEqual([`localhost:${new URL(sink.url).port}`]);
    expect(sink.messages).toMatchObject([
      {
        auth: { password: "p@ss", user: "ops" },
        from: "ops@example.com",
        subject: "Einladung für Jürgen",
        text,
        to: ["juergen@example.com"],
      },
    ]);
  });

  it("keeps a long UTF-8 subject whole and every header line short", async () => {
    const sink = await startMailSink();
    sinks.push(sink);
    const settings = readMailSettings({
      SWIZZLE_MAIL_FROM: "ops@example.com",
      SWIZZLE_SMTP_URL: sink.url,
    });
    if (settings === null) throw new Error("The settings were not read.");
    const subject =
      "Maximiliane Großkopf-Müller-Lüdenscheidt von Überlingen invited you to Swizzle";

    await createSmtpMailer(settings).send({ subject, text: "Hi", to: "a@example.com" });

    const [mail] = sink.messages;
    expect(mail?.subject).toBe(subject);
    for (const line of mail?.headers ?? []) expect(line.length).toBeLessThanOrEqual(78);
  });

  it("fails, instead of waiting, when the egress proxy hangs up before it answers", async () => {
    const proxy = createServer((client) => client.once("data", () => client.end()));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const settings = readMailSettings({
      SWIZZLE_CONTROL_EGRESS_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
      SWIZZLE_MAIL_FROM: "ops@example.com",
      SWIZZLE_SMTP_URL: "smtps://mail.example.com:465",
    });
    if (settings === null) throw new Error("The settings were not read.");

    await expect(
      createSmtpMailer(settings).send({ subject: "Hi", text: "Hi", to: "a@example.com" }),
    ).rejects.toThrow(/closed/u);
  });

  it("refuses to talk in plain text to a server that is not on this machine", async () => {
    const sink = await startMailSink();
    sinks.push(sink);
    const proxy = await connectProxy(Number(new URL(sink.url).port));
    // Only the proxy resolves the server's name; the API container may have no DNS for it.
    const settings = readMailSettings({
      SWIZZLE_CONTROL_EGRESS_PROXY: proxy.url,
      SWIZZLE_MAIL_FROM: "ops@example.com",
      SWIZZLE_SMTP_URL: "smtp://ops:secret@mail.swizzle.invalid:587",
    });
    if (settings === null) throw new Error("The settings were not read.");

    await expect(
      createSmtpMailer(settings).send({ subject: "Hi", text: "Hi", to: "a@example.com" }),
    ).rejects.toThrow(/STARTTLS/u);
    expect(proxy.targets).toEqual(["mail.swizzle.invalid:587"]);
    expect(sink.messages).toEqual([]);
  });

  it("refuses a recipient that would add a header or a second address", async () => {
    const settings = readMailSettings({
      SWIZZLE_MAIL_FROM: "ops@example.com",
      SWIZZLE_SMTP_URL: "smtp://127.0.0.1:9",
    });
    if (settings === null) throw new Error("The settings were not read.");

    await expect(
      createSmtpMailer(settings).send({
        subject: "Hi",
        text: "Hi",
        to: "a@example.com>\r\nBcc: <b@example.com",
      }),
    ).rejects.toThrow(/not one address/u);
  });
});

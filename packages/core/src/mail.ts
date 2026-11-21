import { createTransport } from "nodemailer";

import { ConfigurationError } from "./boot.js";
import { parseEgressProxyUrl, SWIZZLE_CONTROL_EGRESS_PROXY_ENV } from "./http-egress.js";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface MailSettings {
  readonly server: URL;
  readonly from: string;
  readonly proxy: URL | null;
}

export const SWIZZLE_SMTP_URL_ENV = "SWIZZLE_SMTP_URL";
export const SWIZZLE_MAIL_FROM_ENV = "SWIZZLE_MAIL_FROM";

const TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const ADDRESS = /^[^\s<>@,;:"\\]+@[^\s<>@,;:"\\]+$/u;

export function readMailSettings(environment: NodeJS.ProcessEnv): MailSettings | null {
  const raw = environment[SWIZZLE_SMTP_URL_ENV]?.trim();
  if (!raw) return null;
  let server: URL;
  try {
    server = new URL(raw);
  } catch (error) {
    throw mailConfigurationError(
      `${SWIZZLE_SMTP_URL_ENV} must be a URL such as smtps://user:password@mail.example.com:465.`,
      error,
    );
  }
  if (server.protocol !== "smtps:" && server.protocol !== "smtp:") {
    throw mailConfigurationError(
      `${SWIZZLE_SMTP_URL_ENV} must use smtps (TLS, port 465) or smtp (STARTTLS, port 587).`,
    );
  }
  const from = environment[SWIZZLE_MAIL_FROM_ENV]?.trim() ?? "";
  if (envelopeAddress(from) === null) {
    throw mailConfigurationError(
      `${SWIZZLE_MAIL_FROM_ENV} must name the sender, such as Swizzle <ops@example.com>, when ${SWIZZLE_SMTP_URL_ENV} is set.`,
    );
  }
  const proxy = environment[SWIZZLE_CONTROL_EGRESS_PROXY_ENV]?.trim();
  return {
    from,
    proxy: proxy ? parseEgressProxyUrl(SWIZZLE_CONTROL_EGRESS_PROXY_ENV, proxy) : null,
    server,
  };
}

export function createSmtpMailer(settings: MailSettings): Mailer {
  const from = envelopeAddress(settings.from);
  if (from === null) throw mailConfigurationError(`${SWIZZLE_MAIL_FROM_ENV} names no address.`);
  const { server } = settings;
  const transport = createTransport({
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    host: server.hostname.replace(/^\[|\]$/gu, ""),
    name: from.slice(from.indexOf("@") + 1),
    port: Number(server.port || (server.protocol === "smtps:" ? 465 : 587)),
    requireTLS: server.protocol === "smtp:" && !LOOPBACK_HOSTS.has(server.hostname),
    secure: server.protocol === "smtps:",
    socketTimeout: TIMEOUT_MS,
    ...(server.username === ""
      ? {}
      : {
          auth: {
            pass: decodeURIComponent(server.password),
            user: decodeURIComponent(server.username),
          },
        }),
    ...(settings.proxy === null ? {} : { proxy: settings.proxy.href }),
  });
  return {
    async send(message) {
      if (!ADDRESS.test(message.to)) throw new Error("The recipient is not one address.");
      await transport.sendMail({
        from: settings.from,
        subject: message.subject,
        text: message.text,
        to: message.to,
      });
    },
  };
}

function mailConfigurationError(message: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError(
    "MAIL_SETTINGS_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function envelopeAddress(from: string): string | null {
  const bracketed = /<([^<>]*)>\s*$/u.exec(from);
  const address = (bracketed?.[1] ?? from).trim();
  if (/[\r\n]/u.test(from) || !ADDRESS.test(address)) return null;
  return address;
}

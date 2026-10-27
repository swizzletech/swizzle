// A browser in front of SwizzleAuth.handle for tests and verify scripts: it keeps the cookies Better
// Auth sets and sends them back, from one client address and one page origin. A failure's body is
// Swizzle's `{ error, message }`, as the API sends it.

import type { AuthRoute, SwizzleAuth } from "../packages/db/src/auth.js";
import { CLIENT_ADDRESS_HEADER } from "../packages/db/src/auth.js";

/** The session cookie's name while cookies are not Secure. */
export const SESSION_COOKIE = "swizzle.session_token";

export class AuthBrowser {
  readonly #cookies = new Map<string, string>();

  constructor(
    readonly auth: Pick<SwizzleAuth, "handle" | "verifySession">,
    readonly origin: string,
    readonly address = "203.0.113.7",
  ) {}

  async person() {
    return await this.auth.verifySession(new Headers(this.#cookieHeader()));
  }

  /** The raw session token, without the signature the cookie adds. */
  sessionToken(): string | undefined {
    const cookie = this.#cookies.get(SESSION_COOKIE);
    return cookie === undefined ? undefined : decodeURIComponent(cookie).split(".")[0];
  }

  sessionCookie(): string | undefined {
    return this.#cookies.get(SESSION_COOKIE);
  }

  async post(route: AuthRoute, body: unknown, headers: Record<string, string> = {}) {
    const answer = await this.auth.handle(route, {
      body,
      headers: new Headers({
        origin: this.origin,
        [CLIENT_ADDRESS_HEADER]: this.address,
        ...this.#cookieHeader(),
        ...headers,
      }),
    });
    for (const setCookie of answer.headers.getSetCookie()) {
      const [pair = ""] = setCookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1);
      if (value === "" || /max-age=0/iu.test(setCookie)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    const read = answer.ok ? answer.result : { error: answer.error, message: answer.message };
    return {
      body: read as Record<string, unknown> | null,
      headers: answer.headers,
      status: answer.status,
    };
  }

  #cookieHeader(): Record<string, string> {
    if (this.#cookies.size === 0) return {};
    return { cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
  }
}

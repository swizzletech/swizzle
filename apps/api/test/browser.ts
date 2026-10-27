import type { buildServer } from "../src/server.js";

export const DASHBOARD_ORIGIN = "http://127.0.0.1:5173";

/**
 * A dashboard browser for API tests: it keeps the cookies the server sets, sends them back, and
 * names DASHBOARD_ORIGIN, which a test allows with SWIZZLE_DASHBOARD_ORIGIN before it builds the
 * server.
 */
export function testBrowser(app: ReturnType<typeof buildServer>, address = "203.0.113.45") {
  const cookies = new Map<string, string>();
  const send = async (
    method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.inject({
      headers: {
        ...(cookies.size === 0
          ? {}
          : { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") }),
        origin: DASHBOARD_ORIGIN,
        ...headers,
      },
      method,
      remoteAddress: address,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    for (const header of [response.headers["set-cookie"] ?? []].flat()) {
      const [pair = ""] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value === "" || /max-age=0/iu.test(header)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  };
  return {
    cookies,
    send,
    signIn: (email: string, password: string) =>
      send("POST", "/auth/sign-in/email", { email, password }),
  };
}

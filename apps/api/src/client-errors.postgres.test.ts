import { expect, onTestFinished, test } from "vitest";
import { ownerHeaders } from "../test/people.js";
import { buildTestServer } from "../test/server-harness.js";

test.each([
  { method: "POST", url: "/connections/probe/test" },
  { method: "DELETE", url: "/connections/probe" },
] as const)(
  "$method $url rejects an empty JSON body as a client error",
  async ({ method, url }) => {
    const owner = await ownerHeaders();
    const app = await buildTestServer();
    onTestFinished(() => app.close());
    const response = await app.inject({
      method,
      url,
      headers: { ...owner, "content-type": "application/json" },
      payload: "",
    });
    expect({ status: response.statusCode, body: response.json() }).toEqual({
      status: 400,
      body: {
        code: "FST_ERR_CTP_EMPTY_JSON_BODY",
        error: "FST_ERR_CTP_EMPTY_JSON_BODY",
        message: "Body cannot be empty when content-type is set to 'application/json'",
      },
    });
  },
);

test("unsupported request content types retain Fastify's 415 error", async () => {
  const owner = await ownerHeaders();
  const app = await buildTestServer();
  onTestFinished(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/connections/probe/test",
    headers: { ...owner, "content-type": "application/x-unsupported" },
    payload: "input",
  });
  expect(response.statusCode).toBe(415);
  expect(response.json()).toMatchObject({
    code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    error: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
  });
});

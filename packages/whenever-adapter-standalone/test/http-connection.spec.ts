import { describe, expect, it, vi } from "vitest";

import { validateHttpRequestInput } from "../src/http-integration";
import {
  createWorkflowIntegrationsFromEnv,
  type FetchLike,
  type HttpConnection,
} from "../src/index";

const SLACK: HttpConnection = {
  baseUrl: "https://slack.com/api",
  headers: { Authorization: "Bearer xoxb-connection-token" },
};

const TELEGRAM_SECRET = "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const TELEGRAM_TOKEN = `123456789:${TELEGRAM_SECRET}`;
const TELEGRAM_SEGMENT = `bot${TELEGRAM_TOKEN}`;

function telegramEcho(fetch: FetchLike) {
  return createWorkflowIntegrationsFromEnv({
    fetch,
    resolveHost: async () => ["93.184.216.34"],
    httpConnections: {
      telegram: { baseUrl: "https://api.telegram.org", headers: {}, pathSegment: TELEGRAM_SEGMENT },
    },
  });
}

function echoedPath(): Response {
  return new Response(
    JSON.stringify({ ok: false, description: `Not Found: /${TELEGRAM_SEGMENT}/getMe` }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function integrations(fetch: FetchLike) {
  return createWorkflowIntegrationsFromEnv({
    fetch,
    resolveHost: async () => ["93.184.216.34"],
    httpConnections: { slack: SLACK },
  });
}

function sentHeaders(fetch: ReturnType<typeof vi.fn<FetchLike>>): Headers {
  return new Headers(fetch.mock.calls[0]?.[1]?.headers);
}

describe("HTTP requests through a connection", () => {
  it("adds the connection's credential headers to a write", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await integrations(fetch).http.post({
      connection: "slack",
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C1", text: "Got it" },
    });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://slack.com/api/chat.postMessage",
    );
    expect(sentHeaders(fetch).get("authorization")).toBe(
      "Bearer xoxb-connection-token",
    );
  });

  it("adds the connection's credential headers to a read", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await integrations(fetch).http.get({
      connection: "slack",
      url: "https://slack.com/api/auth.test",
    });

    expect(sentHeaders(fetch).get("authorization")).toBe(
      "Bearer xoxb-connection-token",
    );
  });

  it("sends no connection credential when the request names no connection", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await integrations(fetch).http.get({
      url: "https://slack.com/api/auth.test",
    });

    expect(sentHeaders(fetch).get("authorization")).toBeNull();
  });

  it.each([
    ["another origin", "https://example.com/api/chat.postMessage"],
    ["a path beside the base", "https://slack.com/apix/chat.postMessage"],
    ["a path above the base", "https://slack.com/oauth/v2/authorize"],
    ["a dot segment out of the base", "https://slack.com/api/../oauth"],
    ["an encoded dot segment out of the base", "https://slack.com/api/%2e%2e/oauth"],
    ["a dot segment with an encoded slash", "https://slack.com/api/..%2foauth"],
    ["an encoded dot segment with an encoded slash", "https://slack.com/api/%2E%2E%2Foauth"],
    ["a dot segment with an encoded backslash", "https://slack.com/api/..%5Coauth"],
    ["an encoded slash that would read as a host", "https://slack.com/%2f[x"],
    ["a doubled slash that would read as a host", "https://slack.com//[x"],
    ["plain http on the same host", "http://slack.com/api/chat.postMessage"],
  ])("refuses %s before sending", async (_case, url) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await expect(
      integrations(fetch).http.post({ connection: "slack", url, body: {} }),
    ).rejects.toMatchObject({ code: "INVALID_HTTP_REQUEST", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a path whose segment carries an encoded slash below the base", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await integrations(fetch).http.get({
      connection: "slack",
      url: "https://slack.com/api/files%2Finfo",
    });

    expect(sentHeaders(fetch).get("authorization")).toBe("Bearer xoxb-connection-token");
  });

  it("sends a path whose decoded form starts a second slash below the base", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await integrations(fetch).http.get({
      connection: "slack",
      url: "https://slack.com/api/%2f%2f[x",
    });

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refuses a connection the host does not hold", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await expect(
      integrations(fetch).http.post({
        connection: "github",
        url: "https://slack.com/api/chat.postMessage",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_HTTP_REQUEST",
      message: expect.stringContaining('connection "github"'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a connection name inherited from the object prototype", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await expect(
      integrations(fetch).http.get({
        connection: "constructor",
        url: "https://slack.com/api/auth.test",
      }),
    ).rejects.toMatchObject({ code: "INVALID_HTTP_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a caller header the connection sets, whatever its case", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());

    await expect(
      integrations(fetch).http.post({
        connection: "slack",
        url: "https://slack.com/api/chat.postMessage",
        headers: { authorization: "Bearer xoxb-another-app" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_HTTP_REQUEST",
      message: expect.stringContaining("authorization"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["the same origin outside the base", "/oauth/v2/authorize"],
    ["the same origin inside the base", "/api/files.info.v2"],
    ["another origin", "https://elsewhere.example/landing"],
  ])("refuses to follow a redirect to %s with the credential", async (_case, location) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: location } }),
    );

    await expect(
      integrations(fetch).http.get({
        connection: "slack",
        url: "https://slack.com/api/files.info",
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("refuses the redirect when the connection name reads differently the second time", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: "/oauth/v2/authorize" } }),
    );
    let reads = 0;
    const input = {
      url: "https://slack.com/api/auth.test",
      get connection() {
        reads += 1;
        return reads <= 4 ? "slack" : undefined;
      },
    };

    await expect(integrations(fetch).http.get(input)).rejects.toMatchObject({
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends a connection's own content-type with the body", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());
    const formConnection = createWorkflowIntegrationsFromEnv({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
      httpConnections: {
        forms: {
          baseUrl: "https://forms.example.com/submit",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
      },
    });

    await formConnection.http.post({
      connection: "forms",
      url: "https://forms.example.com/submit",
      body: { name: "Ada" },
    });

    expect(fetch.mock.calls[0]?.[1]?.body).toBe("name=Ada");
  });

  it("sends a connection's path credential as the first segment below its base", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());
    const telegram = createWorkflowIntegrationsFromEnv({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
      httpConnections: {
        telegram: { baseUrl: "https://api.telegram.org", headers: {}, pathSegment: TELEGRAM_SEGMENT },
      },
    });

    await telegram.http.post({
      connection: "telegram",
      url: "https://api.telegram.org/sendMessage",
      body: { chat_id: 1, text: "Got it" },
    });

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `https://api.telegram.org/${TELEGRAM_SEGMENT}/sendMessage`,
    );
  });

  it("keeps a path credential out of the failure a refused request reports", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(echoedPath());

    const failure: unknown = await telegramEcho(fetch)
      .http.get({ connection: "telegram", url: "https://api.telegram.org/getMe" })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ retryable: false });
    expect(JSON.stringify(failure)).not.toContain(TELEGRAM_SECRET);
    expect(String(failure)).not.toContain(TELEGRAM_SECRET);
  });

  it("keeps a path credential out of the failure however many headers the request sends", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(echoedPath());
    const headers = Object.fromEntries(
      Array.from({ length: 600 }, (_, index) => [`a-${String(index)}`, `filler-value-${String(index)}`]),
    );

    const failure: unknown = await telegramEcho(fetch)
      .http.get({ connection: "telegram", url: "https://api.telegram.org/getMe", headers })
      .catch((error: unknown) => error);

    expect(String(failure)).toContain("Not Found");
    expect(String(failure)).not.toContain(TELEGRAM_SECRET);
  });

  it.each([
    ["an error field", { ok: false, error: TELEGRAM_SEGMENT }],
    ["a code field", { ok: false, error_code: TELEGRAM_SEGMENT }],
    ["the bare token", { ok: false, error: TELEGRAM_TOKEN }],
    ["the token's secret half", { ok: false, error_code: TELEGRAM_SECRET }],
    ["a description quoting the bare token", { ok: false, description: `Unauthorized token ${TELEGRAM_TOKEN}` }],
  ])("keeps a path credential echoed as %s out of the failure's reason", async (_case, body) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 404, headers: { "Content-Type": "application/json" } }),
    );

    const failure: unknown = await telegramEcho(fetch)
      .http.get({ connection: "telegram", url: "https://api.telegram.org/getMe" })
      .catch((error: unknown) => error);

    expect(String(failure)).toContain("404");
    expect(JSON.stringify(failure)).not.toContain(TELEGRAM_SECRET);
    expect(String(failure)).not.toContain(TELEGRAM_SECRET);
  });

  it("leaves a provider's explanation readable when a connection sends a short header", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "parameter 1 must be a string" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const versioned = createWorkflowIntegrationsFromEnv({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
      httpConnections: { api: { baseUrl: "https://api.example.com", headers: { "X-Api-Version": "1", "X-Empty": "" } } },
    });

    const failure: unknown = await versioned.http
      .get({ connection: "api", url: "https://api.example.com/items" })
      .catch((error: unknown) => error);

    expect(String(failure)).toContain("parameter 1 must be a string");
  });

  it.each([["bot1/../x"], [".."], [""], ["bot1?x=1"], ["bot%2f"], [".\t."], ["\n.."], ["bot 1"], ["botä"], ["bot\\1"]])(
    "refuses to send a path credential %j that is not one segment",
    async (pathSegment) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(okResponse());
      const broken = createWorkflowIntegrationsFromEnv({
        fetch,
        resolveHost: async () => ["93.184.216.34"],
        httpConnections: { telegram: { baseUrl: "https://api.telegram.org", headers: {}, pathSegment } },
      });

      await expect(
        broken.http.get({ connection: "telegram", url: "https://api.telegram.org/getMe" }),
      ).rejects.toMatchObject({ code: "INVALID_HTTP_REQUEST" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("still follows a redirect for a request that names no connection", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "/api/files.info.v2" } }),
      )
      .mockResolvedValueOnce(okResponse());

    const result = await integrations(fetch).http.get({ url: "https://slack.com/api/files.info" });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([[""], ["   "], [7], [null]])(
    "rejects %j as a connection name",
    (connection) => {
      expect(() =>
        validateHttpRequestInput({
          connection,
          url: "https://slack.com/api/auth.test",
        }),
      ).toThrow(/connection must be a non-empty string/u);
    },
  );
});

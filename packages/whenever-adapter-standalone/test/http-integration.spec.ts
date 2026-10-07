import { describe, expect, it, vi } from "vitest";

import { HTTP_REQUEST_BODY_LIMIT_BYTES, requestEnvelope } from "../src/http";
import {
  prepareHttpGetInput,
  prepareHttpWriteInput,
  validateHttpRequestInput,
} from "../src/http-integration";
import {
  createWorkflowIntegrationsFromEnv,
  type FetchLike,
} from "../src/index";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function context(fetch: FetchLike) {
  return createWorkflowIntegrationsFromEnv({
    fetch,
    resolveHost: async () => ["93.184.216.34"],
  });
}

async function getAndCatch(
  fetch: FetchLike,
): Promise<Error & { code?: string; detail?: string }> {
  try {
    await context(fetch).http.get({ url: "https://example.com/resource" });
  } catch (error) {
    return error as Error & { code?: string; detail?: string };
  }
  throw new Error("the request resolved, so there is no refusal to inspect");
}

describe("HTTP integration", () => {
  it("performs a GET, applies query params, and returns status, headers, and parsed body", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse({ hello: "world" }, 200, {
          "Content-Type": "application/json",
          "X-Trace": "abc",
        }),
      );

    const result = await context(fetch).http.get({
      url: "https://example.com/resource",
      headers: { Authorization: "Bearer author-token" },
      query: { page: "2" },
    });

    expect(result).toEqual({
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-trace": "abc",
      },
      body: { hello: "world" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://example.com/resource?page=2",
    );
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization"),
    ).toBe("Bearer author-token");
  });

  it("returns the raw text when the response body is not JSON", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("plain text", { status: 200 }));

    const result = await context(fetch).http.get({
      url: "https://example.com/plain",
    });

    expect(result.body).toBe("plain text");
    expect(result.status).toBe(200);
  });

  it("keeps an oversized safe response nonretryable when stream cancellation fails", async () => {
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const response = new Response(new ReadableStream({ cancel }), {
      status: 200,
      headers: { "Content-Length": "2" },
    });
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response);

    await expect(
      requestEnvelope(fetch, "https://example.com/oversized", {
        code: "HTTP_RESPONSE_TOO_LARGE",
        failureMode: "safe",
        maxResponseBytes: 1,
      }),
    ).rejects.toMatchObject({
      retryable: false,
      code: "HTTP_RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("posts a JSON body with a default application/json content-type", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ id: "created" }, 201));

    const result = await context(fetch).http.post({
      url: "https://example.com/things",
      body: { name: "widget" },
    });

    expect(result).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: { id: "created" },
    });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Content-Type"),
    ).toBe("application/json");
    expect(String(fetch.mock.calls[0]?.[1]?.body)).toBe(
      JSON.stringify({ name: "widget" }),
    );
  });

  it("names the field when a body carries a value JSON cannot encode", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    let refusal: Error | undefined;
    try {
      await context(fetch).http.post({
        url: "https://ntfy.sh/",
        body: { topic: undefined, message: "the alerting path is alive" },
      });
    } catch (error) {
      refusal = error as Error;
    }

    expect(refusal?.message).toContain("body.topic is undefined");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets the author override the content-type header", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.post({
      url: "https://example.com/things",
      body: { name: "widget" },
      headers: { "content-type": "application/vnd.custom+json" },
    });

    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Content-Type"),
    ).toBe("application/vnd.custom+json");
  });

  it("form-encodes the body when the author declares a form content-type", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ sid: "SM1" }, 201));

    await context(fetch).http.post({
      url: "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { To: "+14155550100", From: "+14155550199", Body: "on my way" },
    });

    expect(String(fetch.mock.calls[0]?.[1]?.body)).toBe(
      "To=%2B14155550100&From=%2B14155550199&Body=on+my+way",
    );
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Content-Type"),
    ).toBe("application/x-www-form-urlencoded");
  });

  it("form-encodes when the declared content-type carries a charset", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.post({
      url: "https://example.com/things",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: { name: "widget" },
    });

    expect(String(fetch.mock.calls[0]?.[1]?.body)).toBe("name=widget");
  });

  it("repeats a key for each member of an array in a form body", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.post({
      url: "https://example.com/things",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { MediaUrl: ["https://example.com/a.png", "https://example.com/b.png"] },
    });

    expect(String(fetch.mock.calls[0]?.[1]?.body)).toBe(
      "MediaUrl=https%3A%2F%2Fexample.com%2Fa.png&MediaUrl=https%3A%2F%2Fexample.com%2Fb.png",
    );
  });

  it("names the field when a form body nests a value no form can carry", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    let refusal: Error | undefined;
    try {
      await context(fetch).http.post({
        url: "https://example.com/things",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: { To: "+14155550100", options: { retry: true } },
      });
    } catch (error) {
      refusal = error as Error;
    }

    expect(refusal?.message).toContain("body.options");
    expect(refusal?.message).toContain("form-encoded");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a form body whose getter throws rather than leaking it", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const body = {
      To: "+14155550100",
      get From(): string {
        throw new Error("secret from a workflow accessor");
      },
    };

    let refusal: Error | undefined;
    try {
      await context(fetch).http.post({
        url: "https://example.com/things",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      refusal = error as Error;
    }

    expect((refusal as { code?: string } | undefined)?.code).toBe(
      "INVALID_HTTP_REQUEST",
    );
    expect(refusal?.message).not.toContain("secret from a workflow accessor");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a form body that is not a record of fields", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    let refusal: Error | undefined;
    try {
      await context(fetch).http.post({
        url: "https://example.com/things",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "To=%2B1",
      });
    } catch (error) {
      refusal = error as Error;
    }

    expect(refusal?.message).toContain("form-encoded");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("performs a PUT with a JSON body", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ updated: true }));

    const result = await context(fetch).http.put({
      url: "https://example.com/things/1",
      body: { name: "widget" },
    });

    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { updated: true },
    });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
  });

  it("performs a guarded PATCH with the existing JSON envelope contract", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ updated: true }));

    const result = await context(fetch).http.patch({
      url: "https://example.com/things/1",
      body: { name: "widget" },
      query: { revision: "2" },
    });

    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { updated: true },
    });
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "https://example.com/things/1?revision=2",
    );
    expect(fetch.mock.calls[0]![1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      name: "widget",
    });
  });





  it("classifies a failed GET (safe read) 503 as retryable", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: "busy" }, 503));

    const promise = context(fetch).http.get({
      url: "https://example.com/resource",
    });

    await expect(promise).rejects.toMatchObject({
      retryable: true,
      code: "HTTP_REQUEST_FAILED",
    });
  });

  it("carries the provider's account beside its category, with the customer data masked", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          status: "error",
          message:
            'Property values were not valid: [{"error":"INVALID_EMAIL","name":"email","value":"ada@lovelace.test"}]',
          category: "VALIDATION_ERROR",
        },
        400,
      ),
    );

    const promise = context(fetch).http.get({
      url: "https://example.com/resource",
    });

    await expect(promise).rejects.toThrow(/400/);
    await expect(promise).rejects.toThrow(/VALIDATION_ERROR/);
    await expect(promise).rejects.toThrow(/Property values were not valid/);
    await expect(promise).rejects.not.toThrow(/ada@lovelace\.test/);
  });

  it("carries a Notion-shaped code and the sentence beside it", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          object: "error",
          code: "unauthorized",
          message: "API token is invalid.",
        },
        401,
      ),
    );

    const promise = context(fetch).http.get({
      url: "https://example.com/resource",
    });

    await expect(promise).rejects.toThrow(/unauthorized/);
    await expect(promise).rejects.toThrow(/API token is invalid/);
  });

  it("quotes the provider's explanation when the provider named no machine-readable reason", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          message:
            "Although you appear to have the correct authorization credentials, the " +
            "`example-org` organization has enabled OAuth App access restrictions.",
          documentation_url: "https://docs.github.com/rest",
        },
        403,
      ),
    );

    const failure = await getAndCatch(fetch);

    expect(failure.detail).toMatch(/OAuth App access restrictions/);
    expect(failure.detail).toMatch(/example-org/);
    expect(failure.code).toBe("HTTP_REQUEST_FAILED");
  });

  it("masks the credential and contact shapes it knows before quoting a refusal", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          message:
            "ada@lovelace.test presented bearer eyJhbGciOiJIUzI1NiJ9.payload.sig " +
            "with ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx for account 4111111111111111",
        },
        403,
      ),
    );

    const failure = await getAndCatch(fetch);

    expect(failure.detail).toMatch(/presented/);
    expect(failure.detail).not.toMatch(/ada@lovelace\.test/);
    expect(failure.detail).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
    expect(failure.detail).not.toMatch(/ghp_0123456789/);
    expect(failure.detail).not.toMatch(/4111111111111111/);
  });

  it("masks an author's own key of no recognisable shape when the provider echoes it", async () => {
    const key = "wholly-unguessable-shape-2f7c";
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse({ message: `invalid key ${key} for this workspace` }, 401),
      );

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.get({
        url: "https://example.com/resource",
        headers: { "X-Api-Key": key },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("invalid key [redacted] for this workspace");
    expect(failure?.message).not.toContain(key);
  });

  it("masks an author's key presented in the query string when the provider echoes it", async () => {
    const key = "another-shapeless-secret-9b1e";
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ message: `token ${key} is revoked` }, 403));

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.get({
        url: "https://example.com/resource",
        query: { access_token: key },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("token [redacted] is revoked");
  });

  it("masks an author's key sent in the request body when the provider echoes it", async () => {
    const key = "body-borne-shapeless-key-77af";
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ message: `apiKey ${key} not recognised` }, 401));

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.post({
        url: "https://example.com/resource",
        body: { apiKey: key, page: 2 },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("apiKey [redacted] not recognised");
  });

  it("masks a short key an author named as one, which no shape rule would catch", async () => {
    const key = "short7!";
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ message: `key ${key} is not valid here` }, 401));

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.get({
        url: "https://example.com/resource",
        headers: { "X-Api-Key": key },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("key [redacted] is not valid here");
  });

  it("reads a numeric code nested under a name nobody enumerated", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ errorInfo: { status: 401 } }, 401));

    const failure = await getAndCatch(fetch);

    expect(failure.message).toContain("401");
    expect(failure.message).not.toContain("no_reason_reported");
  });

  it("prefers a nested named code over the status repeated beside it", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ errorInfo: { status: "401", code: "invalid_token" } }, 401),
    );

    const failure = await getAndCatch(fetch);

    expect(failure.message).toContain("invalid_token");
  });

  it("masks the one cookie pair a provider rejected out of the list it was sent", async () => {
    const session = "s%3Asynthetic-session-value";
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ message: `session ${session} expired` }, 401));

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.get({
        url: "https://example.com/resource",
        headers: { Cookie: `theme=dark; session=${session}; locale=en` },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("session [redacted] expired");
  });

  it.each([
    {
      what: "a header no name marks as a credential",
      request: {
        url: "https://example.com/resource",
        headers: { "X-Tenant": "tenant-9f2b-secret" },
      },
      echoed: "tenant-9f2b-secret",
    },
    {
      what: "a path segment",
      request: { url: "https://example.com/v1/keys/tok-88af-2b1c/rotate" },
      echoed: "tok-88af-2b1c",
    },
    {
      what: "userinfo, which authorizes by position",
      request: { url: `https://${"alice:pw-7d3e-9a1f"}@example.com/resource` },
      echoed: "pw-7d3e-9a1f",
    },
    {
      what: "a body field no name marks as a credential",
      request: {
        url: "https://example.com/resource",
        body: { tenant: "tenant-4c8d-secret" },
      },
      echoed: "tenant-4c8d-secret",
    },
    {
      what: "a body field too long to build a matcher from",
      request: {
        url: "https://example.com/resource",
        body: { content: `secret-${"a".repeat(40_000)}` },
      },
      echoed: `secret-${"a".repeat(40_000)}`,
    },
  ])("masks $what when the provider echoes it", async ({ request, echoed }) => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ message: `value ${echoed} was refused` }, 401));

    let failure: (Error & { detail?: string }) | undefined;
    try {
      const http = context(fetch).http;
      await ("body" in request
        ? http.post(request as Parameters<typeof http.post>[0])
        : http.get(request as Parameters<typeof http.get>[0]));
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("value [redacted] was refused");
  });

  it("leaves an ordinary word in the request out of it, so prose survives", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        { message: "the resources collection requires a scope you do not hold" },
        403,
      ),
    );

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.get({
        url: "https://example.com/v1/resources",
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe(
      "the resources collection requires a scope you do not hold",
    );
  });

  it("does not report an RFC 7807 problem type as the reason it stands beside", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          type: "about:blank",
          title: "Bad Request",
          detail: "The order id must be a positive integer.",
          status: 400,
        },
        400,
      ),
    );

    const failure = await getAndCatch(fetch);

    expect(failure.message).not.toContain("about:blank");
    expect(failure.detail).toBe("400: The order id must be a positive integer.");
  });

  it("masks a numeric key sent in the body, which no digit rule is long enough to catch", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ message: "apiKey 123456 is not valid" }, 401));

    let failure: (Error & { detail?: string }) | undefined;
    try {
      await context(fetch).http.post({
        url: "https://example.com/resource",
        body: { apiKey: 123456 },
      });
    } catch (error) {
      failure = error as Error & { detail?: string };
    }

    expect(failure?.detail).toBe("apiKey [redacted] is not valid");
  });

  it("carries both halves of a refusal that classifies itself and explains itself", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(
        {
          error: "Unauthorized",
          message: "API key must be sent in the X-Api-Key header, not as a Bearer token.",
        },
        401,
      ),
    );

    const failure = await getAndCatch(fetch);

    expect(failure.detail).toMatch(/Unauthorized/);
    expect(failure.detail).toMatch(/X-Api-Key header/);
    expect(failure.code).toBe("HTTP_REQUEST_FAILED");
  });

  it("reads an unstructured body but masks the customer data in it", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response("ada@lovelace.test was rejected by the upstream service", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const promise = context(fetch).http.get({
      url: "https://example.com/resource",
    });

    await expect(promise).rejects.toThrow(/400/);
    await expect(promise).rejects.toThrow(/was rejected by the upstream service/);
    await expect(promise).rejects.not.toThrow(/ada@lovelace\.test/);
  });

  it("falls back to a top-level error code when no message is present", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(
        jsonResponse({ object: "error", code: "unauthorized" }, 401),
      );

    const promise = context(fetch).http.get({
      url: "https://example.com/resource",
    });

    await expect(promise).rejects.toThrow(/unauthorized/);
  });

  it("treats a connection failure during a POST as an ambiguous external write", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error("connection closed"));

    const promise = context(fetch).http.post({
      url: "https://example.com/things",
      body: { name: "widget" },
    });

    await expect(promise).rejects.toMatchObject({
      retryable: false,
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
  });

  it("treats a provider 5xx during a POST as an ambiguous external write", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: "busy" }, 503));

    const promise = context(fetch).http.post({
      url: "https://example.com/things",
      body: { name: "widget" },
    });

    await expect(promise).rejects.toMatchObject({
      retryable: false,
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
  });

  it("classifies a POST (write) that is rate limited (429) as retryable", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse({ error: "rate_limited" }, 429));

    const promise = context(fetch).http.post({
      url: "https://example.com/things",
      body: { name: "widget" },
    });

    await expect(promise).rejects.toMatchObject({
      retryable: true,
      code: "HTTP_REQUEST_FAILED",
    });
  });

  it("treats a response-body read failure after a POST as ambiguous", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("response stream closed"));
        },
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response);

    const promise = context(fetch).http.post({
      url: "https://example.com/things",
      body: { name: "widget" },
    });

    await expect(promise).rejects.toMatchObject({
      retryable: false,
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
  });

  it("rejects a malformed URL before performing any request", async () => {
    const fetch = vi.fn<FetchLike>();

    const promise = context(fetch).http.get({ url: "not a url" });

    await expect(promise).rejects.toMatchObject({
      retryable: false,
      code: "INVALID_HTTP_REQUEST",
    });
    expect(fetch).not.toHaveBeenCalled();
  });



  it.each(["get", "post", "put", "patch"] as const)(
    "bounds %s responses through the actual HTTP integration",
    async (method) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(
        new Response("x".repeat(1_048_577), {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      await expect(
        context(fetch).http[method]({
          url: "https://example.com",
          ...("get" === method ? {} : { body: { ok: true } }),
        }),
      ).rejects.toMatchObject({
        retryable: false,
        code:
          method === "get"
            ? "HTTP_REQUEST_FAILED"
            : "AMBIGUOUS_EXTERNAL_WRITE",
      });
    },
  );
});

// This adapter is the validation boundary for `http.*`: its input comes straight from untrusted
// workflow code through the SDK port, with nothing upstream to reject a shape first. So every
// guard below is reachable from a workflow, and each refusal has to name what was wrong rather
// than let a malformed request reach the network.
describe("what http.* refuses before it reaches the network", () => {
  const refusalFor = (
    input: unknown,
  ): { code: string; message: string; retryable: unknown } => {
    try {
      validateHttpRequestInput(input);
      return { code: "accepted", message: "accepted", retryable: "absent" };
    } catch (error) {
      return {
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "none",
        message: error instanceof Error ? error.message : "unknown",
        retryable:
          error instanceof Error && "retryable" in error
            ? (error as { retryable?: unknown }).retryable
            : "absent",
      };
    }
  };

  it("accepts the smallest request a workflow can make", () => {
    expect(refusalFor({ url: "https://api.example.com/thing" }).code).toBe(
      "accepted",
    );
  });

  // A refusal has to be non-retryable, or the runtime re-sends a request that can never become
  // valid. The rows below assert the rule; this asserts the class every one of them belongs to.
  it("refuses without inviting a retry", () => {
    expect(refusalFor(null).retryable).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "https://api.example.com/thing"],
    ["a number", 42],
    ["an array", [{ url: "https://api.example.com/thing" }]],
  ])("refuses %s in place of a request object", (_case, input) => {
    const refusal = refusalFor(input);

    expect(refusal.code).toBe("INVALID_HTTP_REQUEST");
    expect(refusal.message).toContain("input must be an object");
  });

  // A class instance or anything carrying a prototype of its own is refused: the adapter reads
  // the request with `Object.entries`, and a shape whose behaviour lives on a prototype is not
  // the plain record that reading assumes.
  it("refuses a request whose prototype is not a plain object's", () => {
    class Request {
      readonly url = "https://api.example.com/thing";
    }

    expect(refusalFor(new Request()).message).toContain(
      "input must be an object",
    );
  });

  it("accepts a request built with a null prototype", () => {
    const input = Object.assign(Object.create(null) as object, {
      url: "https://api.example.com/thing",
    });

    expect(refusalFor(input).code).toBe("accepted");
  });

  it.each([
    ["absent", {}],
    ["not a string", { url: 42 }],
    ["null", { url: null }],
    ["empty", { url: "" }],
    ["only whitespace", { url: "   \n\t " }],
  ])("refuses a request whose url is %s", (_case, input) => {
    const refusal = refusalFor(input);

    expect(refusal.code).toBe("INVALID_HTTP_REQUEST");
    expect(refusal.message).toContain("url must be a non-empty string");
  });

  it.each([
    ["headers", "headers"],
    ["query", "query"],
  ])("accepts a request that omits %s entirely", (_case, field) => {
    expect(
      refusalFor({ url: "https://api.example.com/thing", [field]: undefined })
        .code,
    ).toBe("accepted");
  });

  it.each([
    ["headers", "a string", "x-api-key: secret"],
    ["headers", "an array", [["x-api-key", "secret"]]],
    ["headers", "null", null],
    ["query", "a string", "page=1"],
    ["query", "an array", [["page", "1"]]],
    ["query", "null", null],
  ])("refuses %s given as %s", (field, _case, value) => {
    const refusal = refusalFor({
      url: "https://api.example.com/thing",
      [field]: value,
    });

    expect(refusal.code).toBe("INVALID_HTTP_REQUEST");
    expect(refusal.message).toContain(`${field} must be an object of strings`);
  });

  it.each([
    ["headers", "an unnamed entry", { "": "secret" }],
    ["headers", "a whitespace-only name", { "   ": "secret" }],
    ["headers", "a numeric value", { "x-count": 1 }],
    ["headers", "a null value", { "x-api-key": null }],
    ["headers", "an object value", { "x-api-key": { secret: true } }],
    ["query", "an unnamed entry", { "": "1" }],
    ["query", "a whitespace-only name", { "  ": "1" }],
    ["query", "a numeric value", { page: 1 }],
    ["query", "an undefined value", { page: undefined }],
  ])("refuses %s carrying %s", (field, _case, value) => {
    const refusal = refusalFor({
      url: "https://api.example.com/thing",
      [field]: value,
    });

    expect(refusal.code).toBe("INVALID_HTTP_REQUEST");
    expect(refusal.message).toContain(
      `${field} must contain non-empty names and string values`,
    );
  });

  // Validation constructs the headers, so a name or value the HTTP grammar forbids is refused
  // here rather than thrown raw from `fetch` as the workflow's own unclassified error.
  it.each([
    ["a space in the name", { "x api key": "secret" }],
    ["a colon in the name", { "x:api:key": "secret" }],
    ["a newline in the value", { "x-api-key": "secret\nInjected: yes" }],
  ])("refuses a header with %s", (_case, headers) => {
    const refusal = refusalFor({
      url: "https://api.example.com/thing",
      headers,
    });

    expect(refusal.code).toBe("INVALID_HTTP_REQUEST");
    expect(refusal.message).toContain("invalid HTTP header");
  });
});

describe("how http.* reads a url a workflow gave it", () => {
  const preparedUrl = (input: unknown): string => {
    try {
      return prepareHttpGetInput(input).url.toString();
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  it.each([
    ["no scheme at all", "api.example.com/thing"],
    ["a bare path", "/thing"],
    ["nothing but a scheme", "https://"],
  ])("refuses a url that is %s", (_case, url) => {
    expect(preparedUrl({ url })).toContain("Invalid request URL");
  });

  it("carries the query a workflow named into the address it requests", () => {
    expect(
      preparedUrl({
        url: "https://api.example.com/thing",
        query: { page: "2", q: "a b" },
      }),
    ).toBe("https://api.example.com/thing?page=2&q=a+b");
  });

  // `set` rather than `append`, so a name given in both places resolves to one value and a
  // workflow cannot smuggle a second copy of a parameter past a provider.
  it("replaces a parameter the url already carried rather than repeating it", () => {
    expect(
      preparedUrl({
        url: "https://api.example.com/thing?page=1",
        query: { page: "2" },
      }),
    ).toBe("https://api.example.com/thing?page=2");
  });

  it("refuses a url the egress guard will not allow", () => {
    expect(preparedUrl({ url: "http://169.254.169.254/latest/meta-data/" })).toContain(
      "private or reserved",
    );
  });


});

describe("what a form-encoded body can carry", () => {
  const encoded = (body: unknown, contentType = "application/x-www-form-urlencoded"): string => {
    try {
      const { init } = prepareHttpWriteInput("POST", {
        url: "https://api.example.com/thing",
        headers: { "content-type": contentType },
        body,
      });
      return String(init.body);
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  it.each([
    ["a string", { field: "value" }, "field=value"],
    ["a boolean", { field: true }, "field=true"],
    ["a number", { field: 2 }, "field=2"],
    ["a negative number", { field: -1 }, "field=-1"],
    ["a zero", { field: 0 }, "field=0"],
  ])("carries %s as a field", (_case, body, expected) => {
    expect(encoded(body)).toBe(expected);
  });

  // Only two of the six shapes `formField` describes can reach it: the strict JSON snapshot
  // refuses undefined, a symbol, a function and a bigint before the encoder runs, so those
  // branches exist for a caller that bypasses the snapshot and cannot be driven from here.
  it.each([
    ["null", { field: null }, "is null"],
    ["a nested array", { field: [["inner"]] }, "is a nested array"],
    ["a nested object", { field: { inner: 1 } }, "is a nested object"],
  ])("names the field when it carries %s", (_case, body, described) => {
    const message = encoded(body);

    expect(message).toContain("body.field");
    expect(message).toContain(described);
  });

  it.each([
    ["undefined", { field: undefined }],
    ["a symbol", { field: Symbol("s") }],
    ["a function", { field: () => 1 }],
    ["a bigint", { field: 1n }],
  ])("refuses a body carrying %s before it is encoded", (_case, body) => {
    expect(encoded(body)).toContain(
      "a form-encoded body must be finite, acyclic strict JSON",
    );
  });

  it("refuses a body that is not a record of fields", () => {
    expect(encoded(["one", "two"])).toContain(
      "form-encoded body must be an object of fields",
    );
  });

  it("refuses a body no strict JSON snapshot can be taken of", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(encoded(cyclic)).toContain(
      "a form-encoded body must be finite, acyclic strict JSON",
    );
  });

  // The content-type decides the encoding, and the comparison reads only the media type, so a
  // charset or a boundary parameter beside it must not change the choice.
  it.each([
    ["with a charset", "application/x-www-form-urlencoded; charset=utf-8"],
    ["in upper case", "APPLICATION/X-WWW-FORM-URLENCODED"],
    [
      "with space before its parameters",
      "application/x-www-form-urlencoded ; charset=utf-8",
    ],
  ])("form-encodes a body whose content-type is declared %s", (_case, contentType) => {
    expect(encoded({ field: "value" }, contentType)).toBe("field=value");
  });

  it.each([
    ["json", "application/json"],
    ["a form-like suffix", "application/x-www-form-urlencoded-not"],
    ["text", "text/plain"],
  ])("does not form-encode a body whose content-type is %s", (_case, contentType) => {
    expect(encoded({ field: "value" }, contentType)).toBe('{"field":"value"}');
  });
});

// The rules above are asserted against the validator directly, which cannot see whether the port
// still calls it. Deleting that one call left every test in the package green while a garbled
// request reached the network, so these drive the whole port and assert nothing was sent.
describe("http.* refuses before anything reaches the network", () => {
  const sending = async (
    input: unknown,
  ): Promise<{ code: string; retryable: unknown; calls: number }> => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    try {
      await context(fetch).http.get(input as { url: string });
      return { code: "sent", retryable: "absent", calls: fetch.mock.calls.length };
    } catch (error) {
      return {
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "none",
        retryable:
          error instanceof Error && "retryable" in error
            ? (error as { retryable?: unknown }).retryable
            : "absent",
        calls: fetch.mock.calls.length,
      };
    }
  };

  it.each([
    ["a request that is not an object", null],
    ["a request with no url", {}],
    [
      "a query that is not an object of strings",
      { url: "https://api.example.com/thing", query: "page=1" },
    ],
    [
      "a query value that is not a string",
      { url: "https://api.example.com/thing", query: { page: 1 } },
    ],
    [
      "a header name the HTTP grammar forbids",
      { url: "https://api.example.com/thing", headers: { "x api key": "k" } },
    ],
  ])("makes no request for %s", async (_case, input) => {
    const outcome = await sending(input);

    expect(outcome.code).toBe("INVALID_HTTP_REQUEST");
    expect(outcome.retryable).toBe(false);
    expect(outcome.calls).toBe(0);
  });

  it("sends the request a valid input describes", async () => {
    expect((await sending({ url: "https://api.example.com/thing" })).calls).toBe(1);
  });
});

describe("the request body a workflow may send", () => {
  const post = async (
    body: unknown,
    contentType = "application/json",
  ): Promise<{ outcome: string; calls: number }> => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    try {
      await context(fetch).http.post({
        url: "https://api.example.com/thing",
        headers: { "content-type": contentType },
        body,
      });
      return { outcome: "sent", calls: fetch.mock.calls.length };
    } catch (error) {
      return {
        outcome: error instanceof Error ? error.message : "unknown",
        calls: fetch.mock.calls.length,
      };
    }
  };

  const fieldOf = (bytes: number): Record<string, string> => ({
    field: "x".repeat(bytes),
  });

  it("sends a json body just inside the limit", async () => {
    expect(await post(fieldOf(HTTP_REQUEST_BODY_LIMIT_BYTES - 64))).toEqual({
      outcome: "sent",
      calls: 1,
    });
  });

  // "Rather than sending it" is the whole claim: a refusal raised after the bytes are already on
  // the wire has not bounded anything.
  it.each([
    ["a json body", "application/json"],
    ["a form body", "application/x-www-form-urlencoded"],
  ])("refuses %s past the limit rather than sending it", async (_case, contentType) => {
    const { outcome, calls } = await post(
      fieldOf(HTTP_REQUEST_BODY_LIMIT_BYTES + 1),
      contentType,
    );

    expect(outcome).toContain("request body exceeds 1 MiB");
    expect(calls).toBe(0);
  });

  it("sends a bodiless write, which a trigger callback often is", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.post({ url: "https://api.example.com/thing" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});

// Both encoders walk a snapshot rather than the caller's object, and each says why in a comment:
// a getter read twice could pass the check and then hand over something else. Neither path had a
// test that reads a getter more than once, so the rule the comments state was unpinned.
describe("a body is read once, not twice", () => {
  const twoFaced = (): { readonly body: Record<string, unknown>; reads: () => number } => {
    let reads = 0;
    const body = {
      get token(): string {
        reads += 1;
        return reads === 1 ? "declared" : "smuggled";
      },
    };
    return { body, reads: () => reads };
  };

  const sentBody = async (
    contentType: string,
  ): Promise<{ sent: string; reads: number }> => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const { body, reads } = twoFaced();

    await context(fetch).http.post({
      url: "https://api.example.com/thing",
      headers: { "content-type": contentType },
      body,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    return { sent: String(fetch.mock.calls[0]?.[1]?.body), reads: reads() };
  };

  it.each([
    ["a json body", "application/json", '{"token":"declared"}'],
    ["a form body", "application/x-www-form-urlencoded", "token=declared"],
  ])(
    "reads %s once and sends what that read declared",
    async (_case, contentType, sent) => {
      expect(await sentBody(contentType)).toEqual({ sent, reads: 1 });
    },
  );

  it("refuses a json body whose getter throws rather than leaking it", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    let message = "sent";

    try {
      await context(fetch).http.post({
        url: "https://api.example.com/thing",
        body: {
          get token(): string {
            throw new Error("the secret is sk-live-abc");
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown";
    }

    expect(message).toContain("body must be finite, acyclic strict JSON");
    expect(message).not.toContain("sk-live-abc");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("how a failed write is classified", () => {
  const failing = async (
    method: "put" | "patch",
    answer: Response | Error,
  ): Promise<string> => {
    const fetch = vi.fn<FetchLike>();
    if (answer instanceof Error) fetch.mockRejectedValue(answer);
    else fetch.mockResolvedValue(answer);

    try {
      await context(fetch).http[method]({
        url: "https://api.example.com/thing",
        body: { field: "value" },
      });
      return "sent";
    } catch (error) {
      return error instanceof Error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "none";
    }
  };

  // A provider that rejected the write has settled that it did not land, so the failure carries
  // the transport's own code. A 5xx or no answer at all has settled nothing, and gets the
  // ambiguous classification instead — the only honest one.
  it.each(["put", "patch"] as const)(
    "carries the transport code when a provider rejected the %s outright",
    async (method) => {
      expect(await failing(method, jsonResponse({ error: "nope" }, 400))).toBe(
        "HTTP_REQUEST_FAILED",
      );
    },
  );

  it.each(["put", "patch"] as const)(
    "reports a %s the provider answered with a server error as ambiguous",
    async (method) => {
      expect(await failing(method, jsonResponse({ error: "nope" }, 503))).toBe(
        "AMBIGUOUS_EXTERNAL_WRITE",
      );
    },
  );

  it.each(["put", "patch"] as const)(
    "reports a %s that never got an answer as an ambiguous write",
    async (method) => {
      expect(await failing(method, new Error("socket hang up"))).toBe(
        "AMBIGUOUS_EXTERNAL_WRITE",
      );
    },
  );
});

import { describe, expect, it } from "vitest";

import {
  type FetchLike,
  machineReadableReason,
  MAX_PROVIDER_DETAIL_LENGTH,
  NO_REASON_REPORTED,
  presentedRequestValues,
  providerRejectionDetail,
  readResponseText,
  redactReportedText,
  requestEnvelope,
  ResponseBodyLimitError,
  responseRetryAfterMs,
  withoutPresentedValues,
  withProviderDetail,
} from "../src/http";

const REDACTED = "[redacted]";

describe("the one redactor for text a failure carries out of this process", () => {
  // Each row is a shape a provider has been seen to echo back, asserted as the whole string the
  // redactor returns. Nothing weaker holds: forbidding the credential lets a redactor mask its
  // prefix and report the rest, and requiring the marker lets one report nothing else.
  it.each([
    [
      "userinfo in a url",
      "https://not-a-real-user:not-a-real-secret@api.example.com/x",
      "https://[redacted]@api.example.com/x",
    ],
    [
      "a query string on a url",
      "GET https://api.example.com/things?api_key=9f3a1c7d2b failed",
      "GET https://api.example.com/things?[redacted] failed",
    ],
    [
      "a query string an author mistyped into prose",
      "the address ?api_key=9f3a1c7d2b is not usable",
      "the address ?[redacted] is not usable",
    ],
    [
      "a bearer scheme",
      "Authorization: Bearer abc.def-ghi",
      "Authorization: [redacted]",
    ],
    [
      "a basic scheme, padding and all",
      "sent basic dXNlcjpwYXNzd29yZA==",
      "sent [redacted]",
    ],
    [
      "a json web token, every segment",
      "rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl here",
      "rejected [redacted] here",
    ],
    ["a slack bot token", "used xoxb-11111-22222-aaaaaaaa", "used [redacted]"],
    ["a slack app token", "used xapp-1-A0001-2222-bbbb", "used [redacted]"],
    [
      "an openai key",
      "key sk-abcdefghijklmnopqrst rejected",
      "key [redacted] rejected",
    ],
    ["a stripe live key", "key sk_live_abcdefghij rejected", "key [redacted] rejected"],
    ["a stripe test key", "key rk_test_abcdefghij rejected", "key [redacted] rejected"],
    [
      "a github token",
      "key ghp_xxxxxxxxxxxxxxxxxxxx rejected",
      "key [redacted] rejected",
    ],
    [
      "a github fine-grained token",
      "key github_pat_abcdefghijklmnop rejected",
      "key [redacted] rejected",
    ],
    [
      "a google api key",
      "key AIzaSyA0123456789abcdefghijklmnopqrstu rejected",
      "key [redacted] rejected",
    ],
    [
      "an aws access key",
      "key AKIAIOSFODNN7EXAMPLE rejected",
      "key [redacted] rejected",
    ],
    [
      "an aws session key",
      "key ASIAIOSFODNN7EXAMPLE rejected",
      "key [redacted] rejected",
    ],
    [
      "an email address",
      "no account for someone@example.com",
      "no account for [redacted]",
    ],
    [
      "a run of digits",
      "card 4111 1111 1111 1111 declined",
      "card [redacted] declined",
    ],
  ])("masks %s", (_case, reported, expected) => {
    expect(redactReportedText(reported)).toBe(expected);
  });

  // A redactor that swallows the explanation is as useless as one that leaks: these shapes look
  // like secrets to a loose pattern and are not.
  it.each([
    ["prose that merely ends in a question mark", "did the write land? apparently not"],
    ["a lowercase spelling of a fixed-width key", "the value akiaiosfodnn7example is unknown"],
    ["a short run of digits", "only 404 today"],
  ])("leaves %s alone", (_case, reported) => {
    expect(redactReportedText(reported)).toBe(reported);
  });

  // Measured, and the trade-off is deliberate: whatever follows a scheme name goes, because a
  // token is far more likely there than a sentence, and losing a word beats leaking a credential.
  it("masks whatever follows a scheme name, prose included", () => {
    expect(redactReportedText("bearer of bad news")).toBe(`${REDACTED} bad news`);
  });

  it("keeps the words around a masked value", () => {
    const redacted = redactReportedText(
      "provider refused Bearer abc.def-ghi for workspace acme",
    );

    expect(redacted).toBe(`provider refused ${REDACTED} for workspace acme`);
  });

  // Control characters, brackets and semicolons come out as spaces so a report cannot carry a
  // terminal escape or a shape that reads as two fields.
  it("flattens anything outside printable ASCII to a single space", () => {
    expect(redactReportedText("ab\tc\nd(e);f  g")).toBe("a b c d e f g");
  });

  // The window is twice the reported cap, so a secret straddling the cut is masked before the cut.
  it("reads no more of a long report than its window", () => {
    const redacted = redactReportedText("z".repeat(4000));

    expect(redacted).toHaveLength(1000);
  });

  it("masks a secret that straddles the reported cap", () => {
    const filler = "z".repeat(495);
    const redacted = redactReportedText(`${filler} Bearer abc.def-ghi tail`);

    expect(redacted).toBe(`${filler} ${REDACTED} tail`);
  });
});

describe("masking the exact values a request presented", () => {
  it("replaces a presented value wherever the provider echoed it", () => {
    expect(
      withoutPresentedValues("token author-token is not for this workspace", [
        "author-token",
      ]),
    ).toBe(`token ${REDACTED} is not for this workspace`);
  });

  // A short presented value inside a longer word is not that value, and masking it would eat the
  // provider's explanation.
  it("leaves a presented value that is part of a longer word", () => {
    expect(withoutPresentedValues("the tokenizer failed", ["token"])).toBe(
      "the tokenizer failed",
    );
  });

  // The edge assertion only means "edge of the value" where the value's own edge is a word
  // character, so a value wrapped in punctuation has to be masked without it.
  it("masks a presented value whose edges are not word characters", () => {
    expect(withoutPresentedValues("sent -abc! to the provider", ["-abc!"])).toBe(
      `sent ${REDACTED} to the provider`,
    );
  });

  it("treats a presented value as text, not as a pattern", () => {
    expect(withoutPresentedValues("sent a+b?c to the provider", ["a+b?c"])).toBe(
      `sent ${REDACTED} to the provider`,
    );
  });

  it("masks a presented value too long to build a matcher from", () => {
    const long = `x${"y".repeat(5000)}`;

    expect(withoutPresentedValues(`sent ${long} onward`, [long])).toBe(
      `sent ${REDACTED} onward`,
    );
  });

  it("reports the text unchanged when nothing was presented", () => {
    expect(withoutPresentedValues("nothing to mask here", [])).toBe(
      "nothing to mask here",
    );
  });
});

describe("how long a provider asked this to wait", () => {
  const retryAfter = (value: string | undefined): number | undefined =>
    responseRetryAfterMs(
      new Response(null, {
        status: 429,
        ...(value === undefined ? {} : { headers: { "Retry-After": value } }),
      }),
    );

  it("reads a delay in seconds as milliseconds", () => {
    expect(retryAfter("30")).toBe(30_000);
  });

  it("reads a zero delay as no wait rather than no answer", () => {
    expect(retryAfter("0")).toBe(0);
  });

  it.each([
    ["no header at all", undefined],
    ["an empty header", ""],
    ["a negative delay", "-5"],
    ["a delay that is not a number", "soon"],
    // The HTTP-date form is allowed by the spec and this reads only the seconds form, so a date
    // has to read as no answer rather than as zero.
    ["an http date", "Wed, 21 Oct 2015 07:28:00 GMT"],
  ])("reports no delay for %s", (_case, value) => {
    expect(retryAfter(value)).toBeUndefined();
  });
});

describe("the bound on a response this reads", () => {
  const body = (text: string, headers: Record<string, string> = {}): Response =>
    new Response(text, { status: 200, headers });

  it("reads the whole body when nothing bounds it", async () => {
    const text = `start${"x".repeat(4990)}end`;

    await expect(readResponseText(body(text), undefined)).resolves.toBe(text);
  });

  it("reads a body that fits the bound", async () => {
    const text = `start${"x".repeat(54)}end`;

    await expect(readResponseText(body(text), 64)).resolves.toBe(text);
  });

  // A provider that declares an oversized body is refused before a byte of it is read, which is
  // the difference between a bound and a measurement.
  it("refuses a declared length over the bound without reading the body", async () => {
    const response = body("x".repeat(500), { "Content-Length": "500" });

    await expect(readResponseText(response, 64)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
    expect(response.bodyUsed || response.body === null).toBe(true);
  });

  it("refuses a body that passes the bound while it streams", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(40)));
        controller.enqueue(new TextEncoder().encode("x".repeat(40)));
        controller.close();
      },
    });

    await expect(
      readResponseText(new Response(stream, { status: 200 }), 64),
    ).rejects.toBeInstanceOf(ResponseBodyLimitError);
  });

  it("reads an absent body as no text", async () => {
    await expect(
      readResponseText(new Response(null, { status: 204 }), 64),
    ).resolves.toBe("");
  });
});

describe("which value a provider gave this is a reason", () => {
  it.each([
    ["a machine-readable code", "invalid_arg_name", "invalid_arg_name"],
    ["a dotted code", "billing.quota.exceeded", "billing.quota.exceeded"],
    ["a numeric code", 404, "404"],
    ["a zero code", 0, "0"],
  ])("reads %s as the reason", (_case, value, reason) => {
    expect(machineReadableReason(value)).toBe(reason);
  });

  // A reason travels into a run record and is matched against, so it has to be a small
  // enumeration. These shapes are prose, a document, or an account number wearing a code's clothes.
  it.each([
    ["a link to documentation", "https://docs.example.com/errors/42"],
    ["an about reference", "about:blank"],
    ["a sentence", "the write did not land"],
    ["a code longer than the field allows", "x".repeat(65)],
    ["a run of digits too long to be an enumeration", 4_111_111_111],
    ["a negative number", -1],
    ["a number that is not whole", 4.5],
    ["a value that is not a scalar", { code: "nope" }],
    ["nothing at all", undefined],
  ])("reports no reason for %s", (_case, value) => {
    expect(machineReadableReason(value)).toBe(NO_REASON_REPORTED);
  });
});

describe("composing what a provider reported", () => {
  it("joins the reason and the prose it came with", () => {
    expect(providerRejectionDetail("invalid_arg_name", "userIds is not a field")).toBe(
      "invalid_arg_name: userIds is not a field",
    );
  });

  it("carries the reason alone when no prose came with it", () => {
    expect(providerRejectionDetail("invalid_arg_name", undefined)).toBe(
      "invalid_arg_name",
    );
  });

  // The placeholder is this side's word for "the provider named nothing", so reporting it back
  // would put our own vocabulary in a provider's mouth.
  it("carries the prose alone when the provider named no reason", () => {
    expect(providerRejectionDetail(NO_REASON_REPORTED, "it went wrong")).toBe(
      "it went wrong",
    );
  });

  it("composes nothing when the provider said nothing", () => {
    expect(providerRejectionDetail(NO_REASON_REPORTED, undefined)).toBeUndefined();
  });

  it("bounds a composed detail to the field it travels in", () => {
    const detail = providerRejectionDetail("code", "z".repeat(4000));

    expect(detail).toHaveLength(MAX_PROVIDER_DETAIL_LENGTH);
  });

  it("marks a provider's account as the provider's when it attaches one", () => {
    expect(withProviderDetail("API request failed.", "quota_exceeded")).toBe(
      "API request failed. (provider reported: quota_exceeded)",
    );
  });

  it("leaves a message alone when the provider reported nothing", () => {
    expect(withProviderDetail("API request failed.", undefined)).toBe(
      "API request failed.",
    );
  });
});

describe("which values a request presented, and so must never be reported back", () => {
  const presented = (
    url: string,
    init?: RequestInit,
  ): string[] => presentedRequestValues(url, init);

  const URL = "https://api.example.com/things";

  // A header named like a credential is collected whatever its value looks like: a short word in
  // an api-key header is still the key.
  it("collects a credential-named header's value however short it is", () => {
    expect(
      presented(URL, { headers: { "x-api-key": "short" } }),
    ).toContain("short");
  });

  // An unnamed header is collected only when its value could not be prose, or every request would
  // mask the words a provider uses to explain itself.
  it.each([
    ["long enough and not a plain word", "9f3a1c7d2b", true],
    ["a plain word", "plainword", false],
    ["too short to be a value", "a1-b2", false],
  ])("collects an unnamed header's value when it is %s", (_case, value, collected) => {
    const values = presented(URL, { headers: { "x-trace": value } });

    expect(values.includes(value)).toBe(collected);
  });

  // These headers describe the request rather than authorise it, so collecting them would mask
  // the content type out of every failure that mentions one.
  it.each(["content-type", "accept", "user-agent", "origin", "cache-control"])(
    "collects nothing from the %s header",
    (name) => {
      expect(presented(URL, { headers: { [name]: "application/json" } })).toEqual(
        [],
      );
    },
  );

  // A provider echoes a bearer token with its scheme as often as without, so both forms are
  // collected from one header.
  it("collects a bearer token with and without its scheme", () => {
    const values = presented(URL, {
      headers: { authorization: "Bearer abc123def456" },
    });

    expect(values).toContain("Bearer abc123def456");
    expect(values).toContain("abc123def456");
  });

  it("collects each pair's value out of a cookie list", () => {
    const values = presented(URL, {
      headers: { cookie: "session=abc123def456; theme=dark" },
    });

    expect(values).toContain("abc123def456");
    expect(values).toContain("dark");
  });

  // Synthetic userinfo on IANA's reserved example domain. The shape is what the rule reads, so
  // it has to be present in the fixture, and nothing exists behind it.
  it("collects userinfo from the address, whatever it is called", () => {
    const values = presented("https://not-a-real-user:not-a-real-secret@api.example.com/things");

    expect(values).toContain("not-a-real-user");
    expect(values).toContain("not-a-real-secret");
  });

  // The query is decoded when it is read and the provider echoes whichever form it received, so a
  // token sent percent-encoded has to be collected both ways.
  it("collects a query value in both the form it was sent and the form it decodes to", () => {
    const values = presented(`${URL}?token=s%3Aabc123`);

    expect(values).toContain("s:abc123");
    expect(values).toContain("s%3Aabc123");
  });

  it("collects a path segment that could not be prose", () => {
    expect(presented("https://api.example.com/v1/9f3a1c7d2b/items")).toContain(
      "9f3a1c7d2b",
    );
  });

  it("collects nothing from headers it cannot parse", () => {
    expect(presented(URL, { headers: { "x api key": "value" } })).toEqual([]);
  });

  it("collects nothing from an address it cannot parse", () => {
    expect(presented("api.example.com/things")).toEqual([]);
  });
});

describe("what the transport reports when a provider refuses", () => {
  interface Refusal {
    code: string;
    message: string;
    detail: unknown;
    retryable: unknown;
    retryAfterMs: unknown;
  }

  const answering = (response: Response | Error): FetchLike =>
    async () => {
      if (response instanceof Error) throw response;
      return response;
    };

  const sending = async (
    response: Response | Error,
    options: {
      failureMode?: "safe" | "write";
      maxResponseBytes?: number;
      timeoutCode?: string;
      init?: RequestInit;
      acceptErrorResponse?: (status: number, body: unknown) => boolean;
    } = {},
  ): Promise<Refusal | { status: number; body: unknown }> => {
    const { failureMode = "safe", ...rest } = options;
    try {
      const envelope = await requestEnvelope(
        answering(response),
        "https://api.example.com/things",
        { code: "HTTP_REQUEST_FAILED", failureMode, ...rest },
      );
      return { status: envelope.status, body: envelope.body };
    } catch (error) {
      const seen = error as Record<string, unknown>;
      return {
        code: String(seen.code),
        message: error instanceof Error ? error.message : "unknown",
        detail: seen.detail === undefined ? "absent" : seen.detail,
        retryable: seen.retryable,
        retryAfterMs: seen.retryAfterMs,
      };
    }
  };

  const json = (body: unknown, status: number, statusText?: string): Response =>
    new Response(JSON.stringify(body), {
      status,
      ...(statusText === undefined ? {} : { statusText }),
      headers: { "Content-Type": "application/json" },
    });

  it("names the status and its phrase in the failure", async () => {
    const outcome = (await sending(
      json({ error: "invalid_arg_name" }, 400, "Bad Request"),
    )) as Refusal;

    expect(outcome.message).toBe(
      "API request failed (400 Bad Request): invalid_arg_name",
    );
    expect(outcome.detail).toBe("invalid_arg_name");
  });

  it("names the status alone when the provider sent no phrase", async () => {
    const outcome = (await sending(json({ error: "invalid_arg_name" }, 418))) as Refusal;

    expect(outcome.message).toBe("API request failed (418): invalid_arg_name");
  });

  it.each([
    ["error as prose", { error: "invalid_arg_name" }, "invalid_arg_name"],
    ["a code nested under error", { error: { code: "invalid_arg_name" } }, "invalid_arg_name"],
    ["a status nested under error", { error: { status: "FAILED_PRECONDITION" } }, "FAILED_PRECONDITION"],
    ["a code at the root", { code: "invalid_arg_name" }, "invalid_arg_name"],
    ["a category at the root", { category: "billing_problem" }, "billing_problem"],
    ["a code buried in a nested field", { data: { detail: { status: "quota_gone" } } }, "quota_gone"],
  ])("reads the reason from %s", async (_case, body, reason) => {
    const outcome = (await sending(json(body, 400))) as Refusal;

    expect(outcome.message).toContain(reason);
  });

  // A number is a reason of last resort: it says nothing a run record can be matched on, so a
  // named one anywhere in the body wins even when the numeric one is found first.
  it("prefers a named reason over a numeric one", async () => {
    const outcome = (await sending(
      json({ code: 409, category: "quota_exceeded" }, 409),
    )) as Refusal;

    expect(outcome.message).toContain("quota_exceeded");
  });

  // The status label already carries the status, so the numeric reason has to differ from it for
  // the assertion to say anything about the body having been read.
  it("falls back to a numeric reason when nothing is named", async () => {
    const outcome = (await sending(json({ code: 451 }, 400))) as Refusal;

    expect(outcome.detail).toBe("451");
    expect(outcome.message).toContain("(400): 451");
  });

  it.each([
    ["a body with nothing to read a reason from", { unrelated: true }],
    ["a body that is not an object", "it went wrong"],
  ])("reports no reason for %s", async (_case, body) => {
    const outcome = (await sending(
      typeof body === "string"
        ? new Response(body, { status: 400 })
        : json(body, 400),
    )) as Refusal;

    expect(outcome.message).toContain(NO_REASON_REPORTED);
  });

  it.each([
    ["a rate limit", 429, "safe" as const, true],
    ["a server error on a read", 503, "safe" as const, true],
    ["a refusal on a read", 400, "safe" as const, false],
    ["a refusal on a write", 400, "write" as const, false],
  ])("classifies %s", async (_case, status, failureMode, retryable) => {
    const outcome = (await sending(json({ error: "nope" }, status), {
      failureMode,
    })) as Refusal;

    expect(outcome.retryable).toBe(retryable);
  });

  it("carries the delay a rate limit asked for", async () => {
    const response = new Response(JSON.stringify({ error: "slow_down" }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "12" },
    });

    expect(((await sending(response)) as Refusal).retryAfterMs).toBe(12_000);
  });

  // A 5xx on a write has not settled whether the write landed, and that doubt outranks whatever
  // the provider said about it.
  it("reports a server error on a write as an ambiguous write", async () => {
    const outcome = (await sending(json({ error: "nope" }, 503), {
      failureMode: "write",
    })) as Refusal;

    expect(outcome.code).toBe("AMBIGUOUS_EXTERNAL_WRITE");
  });

  it("hands back a refusal the caller said it would read", async () => {
    const outcome = await sending(json({ error: "gone" }, 404), {
      acceptErrorResponse: (status) => status === 404,
    });

    expect(outcome).toMatchObject({ status: 404, body: { error: "gone" } });
  });

  it("hands back a body that is not JSON as the text it was", async () => {
    const outcome = await sending(new Response("<html>ok</html>", { status: 200 }));

    expect(outcome).toMatchObject({ status: 200, body: "<html>ok</html>" });
  });

  it("reads an empty body as an empty object", async () => {
    expect(await sending(new Response("", { status: 200 }))).toMatchObject({
      body: {},
    });
  });
});

describe("what the transport reports when it never got an answer", () => {
  const failing = async (
    error: Error,
    options: { failureMode?: "safe" | "write"; timeoutCode?: string } = {},
  ): Promise<{ code: string; message: string; retryable: unknown }> => {
    const { failureMode = "safe", ...rest } = options;
    try {
      await requestEnvelope(
        async () => {
          throw error;
        },
        "https://api.example.com/things",
        { code: "HTTP_REQUEST_FAILED", failureMode, ...rest },
      );
      return { code: "sent", message: "sent", retryable: "absent" };
    } catch (caught) {
      const seen = caught as Record<string, unknown>;
      return {
        code: String(seen.code),
        message: caught instanceof Error ? caught.message : "unknown",
        retryable: seen.retryable,
      };
    }
  };

  const named = (name: string): Error => {
    const error = new Error("it stopped");
    error.name = name;
    return error;
  };

  it("reports a transport failure on a read as worth retrying", async () => {
    const outcome = await failing(new Error("socket hang up"));

    expect(outcome.code).toBe("HTTP_REQUEST_FAILED");
    expect(outcome.retryable).toBe(true);
    expect(outcome.message).toContain("socket hang up");
  });

  // A write that never got an answer may still have landed, so it is never reported as a plain
  // failure and never retried automatically.
  it("reports a transport failure on a write as an ambiguous write", async () => {
    const outcome = await failing(new Error("socket hang up"), {
      failureMode: "write",
    });

    expect(outcome.code).toBe("AMBIGUOUS_EXTERNAL_WRITE");
    expect(outcome.retryable).toBe(false);
  });

  it.each(["TimeoutError", "AbortError"])(
    "separates a deadline named %s from any other failure",
    async (name) => {
      const outcome = await failing(named(name), {
        timeoutCode: "HTTP_REQUEST_TIMEOUT",
      });

      expect(outcome.code).toBe("HTTP_REQUEST_TIMEOUT");
      expect(outcome.retryable).toBe(true);
    },
  );

  // Only a caller that named a timeout code wants one: without it a deadline keeps the ordinary
  // classification rather than inventing a code the caller does not handle.
  it("keeps a deadline classified as the caller asked when it named no timeout code", async () => {
    expect((await failing(named("TimeoutError"))).code).toBe("HTTP_REQUEST_FAILED");
  });

  it("keeps a deadline on a write ambiguous rather than retryable", async () => {
    const outcome = await failing(named("TimeoutError"), { failureMode: "write" });

    expect(outcome.code).toBe("AMBIGUOUS_EXTERNAL_WRITE");
    expect(outcome.retryable).toBe(false);
  });
});

describe("the bound the transport puts on a response it reads", () => {
  const reading = async (
    response: Response,
    failureMode: "safe" | "write",
  ): Promise<{ code: string; message: string; retryable: unknown }> => {
    try {
      await requestEnvelope(
        async () => response,
        "https://api.example.com/things",
        { code: "HTTP_REQUEST_FAILED", failureMode, maxResponseBytes: 64 },
      );
      return { code: "read", message: "read", retryable: "absent" };
    } catch (error) {
      const seen = error as Record<string, unknown>;
      return {
        code: String(seen.code),
        message: error instanceof Error ? error.message : "unknown",
        retryable: seen.retryable,
      };
    }
  };

  const oversized = (): Response =>
    new Response("x".repeat(500), {
      status: 200,
      headers: { "Content-Length": "500" },
    });

  it("refuses a declared oversize before it touches a body it could not read", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("the stream broke");
        },
      }),
      { status: 200, headers: { "Content-Length": "500" } },
    );

    const outcome = await reading(response, "safe");

    expect(outcome.message).toContain("exceeds 64 bytes");
    expect(outcome.message).not.toContain("the stream broke");
    expect(outcome.retryable).toBe(false);
  });

  // What this pins is the classification and the bound in the message. That the guard fires before
  // the body is read is the sibling above, which is the only observation that tells the two apart:
  // cancelling a stream pulls from it too, so a chunk count cannot.
  it("refuses an oversized answer to a read with the caller's code", async () => {
    const outcome = await reading(oversized(), "safe");

    expect(outcome.code).toBe("HTTP_REQUEST_FAILED");
    expect(outcome.message).toContain("exceeds 64 bytes");
    // A response that could not be validated is not worth asking for again.
    expect(outcome.retryable).toBe(false);
  });

  // A write whose answer cannot be read has not been validated, and an unvalidated write is
  // doubt rather than failure.
  it("reports an oversized answer to a write as an ambiguous write", async () => {
    const outcome = await reading(oversized(), "write");

    expect(outcome.code).toBe("AMBIGUOUS_EXTERNAL_WRITE");
    expect(outcome.retryable).toBe(false);
  });

  it.each([
    [1_500_000, "1.43 MiB"],
    [12_345_678, "11.77 MiB"],
  ])("names a %d-byte limit in a form the redactor keeps", async (limit, named) => {
    const refused = await requestEnvelope(
      async () =>
        new Response(null, { status: 200, headers: { "Content-Length": String(limit + 1) } }),
      "https://api.example.com/things",
      { code: "HTTP_REQUEST_FAILED", failureMode: "safe", maxResponseBytes: limit },
    ).catch((error: unknown) => (error instanceof Error ? error.message : "unknown"));

    expect(redactReportedText(String(refused))).toBe(`API response exceeds ${named}.`);
  });

  // A declared length that is not a number tells the reader nothing, so the bound has to be
  // enforced while the body streams instead.
  it("enforces the bound while streaming when the declared length is unreadable", async () => {
    const response = new Response("x".repeat(500), {
      status: 200,
      headers: { "Content-Length": "many" },
    });

    const outcome = await reading(response, "safe");

    expect(outcome.message).toContain("exceeds 64 bytes");
    expect(outcome.retryable).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  machineReadableReason,
  presentedRequestValues,
  providerReportedDetail,
} from "../src/http";

const REASON = "invalid_arg_name";

function detail(messages: unknown): string | undefined {
  return providerReportedDetail(
    { ok: false, error: REASON, response_metadata: { messages } },
    REASON,
  );
}

describe("a provider's account of what it refused", () => {
  it("carries the prose beside the code", () => {
    expect(detail(["[ERROR] invalid arg name: userIds"])).toBe(
      "[ERROR] invalid arg name: userIds",
    );
  });

  it("cannot forge a second line of the log it lands in", () => {
    expect(detail(["first\n2026-08-17 ERROR forged"])).toBe(
      "first [redacted] ERROR forged",
    );
  });

  it("cannot forge the framing it is written inside", () => {
    expect(detail(["ok) (slack reported: everything is fine"])).toBe(
      "ok slack reported: everything is fine",
    );
  });

  it("drops every character a terminal or a log reader would act on", () => {
    expect(detail(["\u001b[31mred\u001b[0m\u0000\u0007bell"])).toBe("[31mred [0m bell");
    expect(detail(["\u202ereversed\u2066isolated"])).toBe("reversed isolated");
    expect(detail(["tab\ttext"])).toBe("tab text");
  });

  it("caps the length at what a bounded failure message can still carry", () => {
    expect(detail([`${"a".repeat(600)}TAIL`])).toBe("a".repeat(500));
  });

  it("masks user data instead of dropping the explanation with it", () => {
    expect(detail(["no such user for email ada@customer-example.com"])).toBe(
      "no such user for email [redacted]",
    );
    expect(detail(["refused text: card 4242424242424242"])).toBe(
      "refused text: card [redacted]",
    );
    expect(detail(["card 4242 4242 4242 4242 was declined"])).toBe(
      "card [redacted] was declined",
    );
    expect(detail(["cannot reach +1 555-867-5310 on a trial"])).toBe(
      "cannot reach [redacted] on a trial",
    );
  });

  it("masks a credential a provider echoed back", () => {
    expect(detail(["callback https://hook.example/path?token=s3cret failed"])).toBe(
      "callback https://hook.example/path?[redacted] failed",
    );
    expect(detail(["token xoxb-1234-abcd is not valid for this workspace"])).toBe(
      "token [redacted] is not valid for this workspace",
    );
    expect(detail(["header Bearer eyJhbGciOi.J9 was rejected"])).toBe(
      "header [redacted] was rejected",
    );
  });

  it("masks the credential shapes a provider other than ours would echo", () => {
    expect(detail(["key AIzaSyB1a2b3c4d5eNOPQRSTuvwxYZ_abcdefghij is not valid"])).toBe(
      "key [redacted] is not valid",
    );
    expect(detail(["caller AKIAIOSFODNN7EXAMPLE is denied"])).toBe(
      "caller [redacted] is denied",
    );
    expect(detail(["token ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx expired"])).toBe(
      "token [redacted] expired",
    );
    expect(detail(["token ghu_0123456789abcdefghijklmnopqrstuvwxyz expired"])).toBe(
      "token [redacted] expired",
    );
    expect(detail(["app token xapp-1-A123-456-abcdef was revoked"])).toBe(
      "app token [redacted] was revoked",
    );
  });

  it("masks a basic-scheme credential and a token carrying no scheme at all", () => {
    expect(detail(["header Basic YWxhZGRpbjpvcGVuc2VzYW1l was rejected"])).toBe(
      "header [redacted] was rejected",
    );
    expect(
      detail(["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N was rejected"]),
    ).toBe("[redacted] was rejected");
  });

  it("reads a refusal out of a shape nobody enumerated", () => {
    const read = (body: unknown): string | undefined =>
      providerReportedDetail(body, "no_reason_reported");

    expect(read({ detail: "Invalid API token." })).toBe("Invalid API token.");
    expect(read({ error_description: "The access token expired." })).toBe(
      "The access token expired.",
    );
    expect(read({ Message: "User is not authorized to perform this action." })).toBe(
      "User is not authorized to perform this action.",
    );
    expect(read({ errors: [{ detail: "Missing required scope." }] })).toBe(
      "Missing required scope.",
    );
    expect(read({ msg: "signature verification failed" })).toBe(
      "signature verification failed",
    );
  });

  it("prefers the explaining field over a bare identifier beside it", () => {
    expect(
      providerReportedDetail(
        {
          type: "https://example.test/problems/unauthorized",
          title: "Unauthorized",
          detail: "The token expired at midnight.",
          status: 401,
        },
        "no_reason_reported",
      ),
    ).toBe("The token expired at midnight.");
  });

  it("prefers the occurrence's explanation over the summary label naming its class", () => {
    expect(
      providerReportedDetail(
        {
          type: "https://example.test/problems/bad-request",
          title: "Bad Request",
          detail: "The OAuth token has expired.",
          status: 400,
        },
        "no_reason_reported",
      ),
    ).toBe("The OAuth token has expired.");
  });

  it("still reads a labelling key when it is the only prose the provider sent", () => {
    expect(
      providerReportedDetail({ error: "Access denied by the organization" }, "no_reason_reported"),
    ).toBe("Access denied by the organization");
  });

  it("masks a key the provider echoed back, whatever shape the author's key has", () => {
    expect(
      providerReportedDetail(
        { message: "invalid key wholly-unguessable-shape for this workspace" },
        "no_reason_reported",
        ["wholly-unguessable-shape"],
      ),
    ).toBe("invalid key [redacted] for this workspace");
  });

  it("reads a one-word plain-text body as the whole reason, not as an identifier", () => {
    expect(providerReportedDetail("Unauthorized", "no_reason_reported")).toBe("Unauthorized");
  });

  it("never quotes a value filed under a credential's own name", () => {
    expect(
      providerReportedDetail({ password: "hunter2 correct horse" }, "no_reason_reported"),
    ).toBeUndefined();
    expect(
      providerReportedDetail({ access_token: "a value that reads like prose" }, "no_reason_reported"),
    ).toBeUndefined();
  });

  it("still reads a reason whose key merely contains a credential word", () => {
    expect(
      providerReportedDetail({ oauth_error: "The consent screen was dismissed" }, "no_reason_reported"),
    ).toBe("The consent screen was dismissed");
  });

  it("never reports where to read about a failure as the account of it", () => {
    expect(
      providerReportedDetail(
        { error: "Unauthorized", documentation_url: "https://docs.example.test/rest" },
        "Unauthorized",
      ),
    ).toBeUndefined();
  });

  it("still quotes prose that merely contains a link", () => {
    expect(
      providerReportedDetail(
        { message: "The token expired, see https://docs.example.test/rest to renew it" },
        "no_reason_reported",
      ),
    ).toBe("The token expired, see https://docs.example.test/rest to renew it");
  });

  it("masks a short key where it stands alone without gutting words containing it", () => {
    expect(
      providerReportedDetail(
        { message: "key abc rejected for the abcdef account" },
        "no_reason_reported",
        ["abc"],
      ),
    ).toBe("key [redacted] rejected for the abcdef account");
  });

  it("masks every occurrence, not the first, when a provider repeats what it refused", () => {
    expect(
      providerReportedDetail(
        { message: "key tok-9f2b-value invalid; retry without tok-9f2b-value" },
        "no_reason_reported",
        ["tok-9f2b-value"],
      ),
    ).toBe("key [redacted] invalid retry without [redacted]");
  });

  it("never reports a field nobody named as an account of the failure", () => {
    expect(providerReportedDetail({ data: "Ada Lovelace" }, "no_reason_reported")).toBeUndefined();
    expect(
      providerReportedDetail({ customer: "a readable looking value" }, "no_reason_reported"),
    ).toBeUndefined();
  });

  it("reads an unstructured body, which is the whole reason a provider gave", () => {
    expect(providerReportedDetail("Invalid token for this workspace", "no_reason_reported")).toBe(
      "Invalid token for this workspace",
    );
  });

  it("never repeats the code it already reported as the reason", () => {
    expect(providerReportedDetail({ error: "Unauthorized" }, "Unauthorized")).toBeUndefined();
  });

  it("leaves a provider's own error code and a short number readable", () => {
    expect(detail(["Error 21611: too many queued messages for 3 hours"])).toBe(
      "Error 21611: too many queued messages for 3 hours",
    );
  });

  it("masks a date, which is a digit run like any other", () => {
    expect(detail(["quota resets 2026-08-18T10:00:00Z"])).toBe(
      "quota resets [redacted]T10:00:00Z",
    );
  });

  it("masks an address the cap would otherwise cut in half", () => {
    const detailText = detail([`${"filler ".repeat(70)}ada@customer-example.com`]);

    expect(detailText).not.toContain("ada@");
    expect(detailText).not.toMatch(/\S+@/u);
  });

  it("stays inside a cost budget on a body-sized message", () => {
    const started = performance.now();
    detail([`${"a".repeat(64)}@`.repeat(16_000)]);

    expect(performance.now() - started).toBeLessThan(50);
  });

  it("stays inside a cost budget on a URL presenting as many values as it can", () => {
    const url = `https://example.com/${Array.from({ length: 20_000 }, (_, index) => `tok-${index}-value`).join("/")}`;
    const started = performance.now();

    providerReportedDetail(
      { message: "x".repeat(1_000_000) },
      "no_reason_reported",
      presentedRequestValues(url, undefined),
    );

    expect(performance.now() - started).toBeLessThan(200);
  });

  it("masks a presented value longer than a matcher can be built from", () => {
    const secret = `key-${"a".repeat(40_000)}`;

    expect(
      providerReportedDetail(
        { message: `rejected value ${secret} is too long` },
        "no_reason_reported",
        [secret],
      ),
    ).toBe("rejected value [redacted] is too long");
  });

  it("reads the prose wherever the provider put it", () => {
    expect(providerReportedDetail({ message: "The To number is not valid." }, REASON)).toBe(
      "The To number is not valid.",
    );
    expect(
      providerReportedDetail({ error: { code: REASON, message: "no such field" } }, REASON),
    ).toBe("no such field");
    expect(
      providerReportedDetail({ error: null, message: "still readable" }, REASON),
    ).toBe("still readable");
  });

  it("reports nothing when the provider said nothing a log can carry", () => {
    for (const messages of [
      undefined,
      [],
      [{ nested: "object" }, 42, null],
      ["   "],
      ["\u{1F4A5}"],
      [REASON],
    ]) {
      expect(detail(messages), JSON.stringify(messages)).toBeUndefined();
    }
    expect(providerReportedDetail(null, REASON)).toBeUndefined();
  });
});

// Provider-controlled codes and nested bodies need independent reporting bounds.
describe("the code a provider answered with", () => {
  it.each([0, 1, 404, 999_999])("repeats %o as a reported code", (value) => {
    expect(machineReadableReason(value)).toBe(String(value));
  });

  // Past the bound it is an identifier or a timestamp rather than a code, and repeating it would
  // put an unbounded number into a field the protocol caps.
  it.each([
    1_000_000,
    1_000_001,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])("does not repeat %o as a code", (value) => {
    expect(machineReadableReason(value)).not.toBe(String(value));
  });
});

describe("how far into a body the adapter will look", () => {
  const EXPLANATION = "The channel you asked for does not exist.";

  // The root is visited at depth 0 and the walk stops past depth 6, so wrapping the explanation
  // `wrappers` deep puts it at depth 2 + wrappers once it is filed under `nested`.
  function buried(wrappers: number): unknown {
    let node: unknown = { message: EXPLANATION };
    for (let i = 0; i < wrappers; i += 1) node = { inner: node };
    return { ok: false, nested: node };
  }

  it("reads an explanation sitting on the deepest level it walks", () => {
    expect(providerReportedDetail(buried(4), "invalid_arg_name")).toContain(
      "does not exist",
    );
  });

  // One level further is the first the walk refuses, so a body nested to exhaust it costs a
  // bounded traversal and reports nothing rather than everything.
  it("stops one level past the deepest it walks", () => {
    expect(providerReportedDetail(buried(5), "invalid_arg_name") ?? "").not.toContain(
      "does not exist",
    );
  });

  it("stops on a body nested far past that", () => {
    expect(providerReportedDetail(buried(40), "invalid_arg_name") ?? "").not.toContain(
      "does not exist",
    );
  });

  // The leaf cap is counted across the whole body, so filling it with values that explain nothing
  // is enough to push a real explanation out of reach.
  function crowded(fillers: number): unknown {
    const body: Record<string, unknown> = { ok: false };
    for (let i = 0; i < fillers; i += 1) body[`f${String(i)}`] = `filler ${String(i)}`;
    body.message = EXPLANATION;
    return body;
  }

  it("reads an explanation arriving on the last leaf it will collect", () => {
    expect(providerReportedDetail(crowded(255), "invalid_arg_name")).toContain(
      "does not exist",
    );
  });

  it("stops collecting once the body has filled the leaf cap", () => {
    expect(
      providerReportedDetail(crowded(256), "invalid_arg_name") ?? "",
    ).not.toContain("does not exist");
  });

  it("keeps walking a body that only cycles back on itself", () => {
    const cyclic: Record<string, unknown> = { message: "Seen once and no more." };
    cyclic.self = cyclic;
    expect(() =>
      providerReportedDetail({ ok: false, nested: cyclic }, "invalid_arg_name"),
    ).not.toThrow();
  });
});

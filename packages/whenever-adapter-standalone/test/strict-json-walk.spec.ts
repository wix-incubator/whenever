import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/http";
import { createWorkflowIntegrationsFromEnv } from "../src/runtime";
import { strictJsonSnapshot, strictJsonViolation } from "../src/strict-json";

const snapshotOf = (value: unknown): unknown =>
  strictJsonSnapshot(value)?.value;

const violation = (value: unknown): string | undefined =>
  strictJsonViolation(value, "body");

describe("what the strict JSON walk refuses, and where it says the fault is", () => {
  it.each([
    ["undefined", undefined, "body is undefined"],
    ["a bigint", 10n, "body is a bigint"],
    ["a function", (): void => undefined, "body is a function"],
    ["a symbol", Symbol("s"), "body is a symbol"],
    ["not a number", Number.NaN, "body is NaN"],
    ["infinity", Number.POSITIVE_INFINITY, "body is Infinity"],
    ["negative infinity", Number.NEGATIVE_INFINITY, "body is -Infinity"],
  ])("refuses %s and names the reason", (_case, value, described) => {
    expect(snapshotOf(value)).toBeUndefined();
    expect(violation(value)).toBe(described);
  });

  // The path is assembled as the throw unwinds, so a fault deep in a request points at itself
  // rather than at the whole body.
  it.each([
    ["a property", { inner: undefined }, "body.inner is undefined"],
    ["an element", [undefined], "body[0] is undefined"],
    [
      "a property under an element",
      { outer: [{ inner: undefined }] },
      "body.outer[0].inner is undefined",
    ],
    [
      "an element under a property",
      { outer: { list: [1, 10n] } },
      "body.outer.list[1] is a bigint",
    ],
  ])("points at %s that is at fault", (_case, value, described) => {
    expect(violation(value)).toBe(described);
  });

  // A hole is skipped by map and forEach but serializes as null, so it is refused rather than
  // copied — and it is named apart from an explicit undefined, which is a different mistake.
  it("tells a hole in an array apart from an undefined element", () => {
    const sparse: unknown[] = [1];
    sparse[2] = 3;

    expect(violation(sparse)).toBe("body[1] is a hole");
    expect(violation([1, undefined, 3])).toBe("body[1] is undefined");
  });

  // A value appearing twice is not a cycle: the ancestor set is unwound as the walk leaves each
  // node, or a request repeating one object would be refused for a fault it does not have.
  it("accepts the same value appearing twice beside itself", () => {
    const shared = { id: "a" };

    expect(snapshotOf({ first: shared, second: shared })).toEqual({
      first: { id: "a" },
      second: { id: "a" },
    });
  });

  it("refuses a value whose own encoder would decide what it becomes", () => {
    expect(violation({ toJSON: (): string => "encoded" })).toBe(
      "body.toJSON is a function",
    );
  });

  it.each([
    ["a string", "text"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["an empty object", {}],
    ["an empty array", []],
  ])("copies %s through unchanged", (_case, value) => {
    expect(snapshotOf(value)).toEqual(value);
  });

  // JSON has one zero, so keeping -0 would leave the snapshot holding a value the encoded
  // request does not carry.
  it("normalises a negative zero to the only zero JSON has", () => {
    expect(Object.is(snapshotOf(-0), 0)).toBe(true);
  });

  it("copies rather than shares the object it was given", () => {
    const original = { nested: { count: 1 } };
    const copied = snapshotOf(original) as { nested: { count: number } };

    copied.nested.count = 2;

    expect(original.nested.count).toBe(1);
  });

  // Plain assignment would route this key through the inherited setter, changing the copy's
  // prototype and losing the property JSON would have kept.
  it("keeps a property named __proto__ as a property", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<
      string,
      unknown
    >;
    const copied = snapshotOf(parsed) as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(copied, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect((copied as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("the budget the walk is allowed", () => {
  it("counts every node, not only the containers", () => {
    expect(
      strictJsonSnapshot({ a: 1, b: 2 }, { maxNodes: 2 }),
    ).toBeUndefined();
  });

  it("reads an unbounded walk as unbounded", () => {
    const deep = { level: { level: { level: { level: { level: 1 } } } } };

    expect(strictJsonSnapshot(deep)?.value).toEqual(deep);
  });
});

describe("dropping the undefined properties a caller allows", () => {
  // Only a property: an undefined element would serialize as null, so dropping it would change
  // the shape of the list rather than trim a field nobody set.
  it("still refuses an undefined element of an array", () => {
    expect(
      strictJsonSnapshot([undefined], {
        maxNodes: Number.POSITIVE_INFINITY,
        dropUndefinedProperties: true,
      }),
    ).toBeUndefined();
  });

  it("refuses an undefined property when the caller did not ask", () => {
    expect(snapshotOf({ kept: 1, gone: undefined })).toBeUndefined();
  });
});

describe("the ports a workflow host is handed", () => {
  const integrations = (
    options: Parameters<typeof createWorkflowIntegrationsFromEnv>[0] = {},
  ): ReturnType<typeof createWorkflowIntegrationsFromEnv> =>
    createWorkflowIntegrationsFromEnv(options);

  it("hands over every port the sdk declares", () => {
    const ports = integrations({ fetch: vi.fn<FetchLike>() });

    expect(Object.keys(ports).sort()).toEqual([
      "ai",
      "http",
      "mcp",
      "postgres",
    ]);
  });

  // An ai port nobody supplied must refuse rather than be absent, so a workflow calling it gets a
  // classified failure instead of a crash on undefined.
  it.each([
    [
      "generateText",
      async (ports: ReturnType<typeof integrations>) =>
        await ports.ai.generateText({ prompt: "hello" }),
      "ai.generateText",
    ],
    [
      "generateImage",
      async (ports: ReturnType<typeof integrations>) =>
        await ports.ai.generateImage({ prompt: "hello" }),
      "ai.generateImage",
    ],
  ])("refuses %s when the host supplied no implementation", async (_case, call, operation) => {
    const ports = integrations({ fetch: vi.fn<FetchLike>() });

    // The classified refusal, not merely a throw: an absent port throws a TypeError, which a
    // workflow cannot read and a run record cannot classify.
    await expect(call(ports)).rejects.toMatchObject({
      code: "AI_GENERATION_UNAVAILABLE",
      operation,
      retryable: false,
    });
  });

  it("uses the text implementation the host supplied", async () => {
    const generateText = vi.fn(async () => ({ text: "written" }));
    const ports = integrations({
      fetch: vi.fn<FetchLike>(),
      generateText: generateText as never,
    });

    await expect(ports.ai.generateText({ prompt: "hello" })).resolves.toEqual({
      text: "written",
    });
  });

  it("sends a workflow's http request through the fetch it was given", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await integrations({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
    }).http.get({ url: "https://api.example.com/thing" });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // The resolver is what turns a host name into the addresses the egress guard checks, so a
  // caller that supplies one has it consulted rather than the default.
  it("resolves a host through the resolver the caller supplied", async () => {
    const resolveHost = vi.fn(async () => ["127.0.0.1"]);
    const fetch = vi.fn<FetchLike>();

    await expect(
      integrations({ fetch, resolveHost }).http.get({
        url: "https://api.example.com/thing",
      }),
    ).rejects.toMatchObject({ code: "HTTP_EGRESS_BLOCKED" });
    expect(resolveHost).toHaveBeenCalledWith("api.example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  // With no fetch supplied the host's own global is what a workflow's request goes through, which
  // is what makes an exported workflow runnable on a plain Node process.
  it("sends a request through the global fetch when the caller supplied none", async () => {
    const global = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", global);

    try {
      await integrations({ resolveHost: async () => ["93.184.216.34"] }).http.get({
        url: "https://api.example.com/thing",
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(global).toHaveBeenCalledTimes(1);
  });

  // A name on the blocked list is refused as a name, before any resolver is consulted, so this
  // holds whether or not the host supplied one. The default resolver's own body needs a live
  // lookup to reach, which this package does not do.
  it("refuses a blocked host name with no resolver of its own", async () => {
    const fetch = vi.fn<FetchLike>();

    await expect(
      integrations({ fetch }).http.get({ url: "http://localhost/thing" }),
    ).rejects.toMatchObject({ code: "HTTP_EGRESS_BLOCKED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  // The handshake may go over a fetch the caller does not observe, so a probe it supplies is the
  // one the lifecycle uses and the other stays for the call itself.
  it("opens an mcp session over the probe fetch the caller supplied", async () => {
    const answer = (id: number, result: unknown): Response =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const lifecycle = (init: RequestInit | undefined): string =>
      String((JSON.parse(String(init?.body)) as { method: string }).method);
    const probed: string[] = [];
    const dispatched: string[] = [];
    const server: FetchLike = async (_url, init) => {
      const method = lifecycle(init);
      const id = (JSON.parse(String(init?.body)) as { id: number }).id;
      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (method === "initialize") {
        return answer(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
        });
      }
      return answer(id, { structuredContent: { ok: true } });
    };

    await integrations({
      fetch: async (url, init) => {
        dispatched.push(lifecycle(init));
        return await server(url, init);
      },
      probeFetch: async (url, init) => {
        probed.push(lifecycle(init));
        return await server(url, init);
      },
      resolveHost: async () => ["93.184.216.34"],
    }).mcp.read({ url: "https://mcp.example.com/mcp", toolName: "ping" });

    expect(probed).toEqual(["initialize", "notifications/initialized"]);
    expect(dispatched).toEqual(["tools/call"]);
  });
});

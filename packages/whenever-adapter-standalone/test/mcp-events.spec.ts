import { describe, expect, it, type Mock, vi } from "vitest";

import type { FetchLike } from "../src/index";
import {
  createMcpEventsClient,
  MCP_EVENTS_EXTENSION,
  MCP_MODERN_PROTOCOL_VERSION,
  type McpEventsError,
} from "../src/internal";

const TARGET = { url: "https://mcp.example.com/mcp" };
const SECRET = `whsec_${btoa("k".repeat(32))}`;

interface Rpc {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type Answer = Response | { result: unknown } | { error: { code: number; message: string; data?: unknown } };

function rpcOf(init: RequestInit | undefined): Rpc {
  return JSON.parse(String(init?.body)) as Rpc;
}

function frame(id: number, answer: { result: unknown } | { error: unknown }, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A server of either era. `events` answers every events/* request; returning undefined answers
 * method-not-found the way a server without the method does.
 */
function server(options: {
  era: "modern" | "legacy";
  capabilities?: Record<string, unknown>;
  events?: (rpc: Rpc, headers: Headers) => Answer | undefined;
}) {
  const capabilities = options.capabilities ?? { extensions: { [MCP_EVENTS_EXTENSION]: {} } };
  return vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
    const rpc = rpcOf(init);
    const headers = new Headers(init?.headers);
    if (rpc.method === "server/discover") {
      return options.era === "modern"
        ? frame(rpc.id, { result: { supportedVersions: [MCP_MODERN_PROTOCOL_VERSION], capabilities, serverInfo: { name: "s", version: "1" } } })
        : frame(rpc.id, { error: { code: -32601, message: "Method not found" } });
    }
    if (rpc.method === "initialize") {
      return frame(rpc.id, { result: { protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "s", version: "1" } } });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    const answer = options.events?.(rpc, headers);
    if (answer === undefined) return frame(rpc.id, { error: { code: -32601, message: "Method not found" } });
    return answer instanceof Response ? answer : frame(rpc.id, answer);
  });
}

function client(fetch: FetchLike) {
  return createMcpEventsClient({ fetch, resolveHost: async () => ["93.184.216.34"] });
}

function methods(fetch: Mock<FetchLike>): string[] {
  return fetch.mock.calls.map(([, init]) => rpcOf(init).method);
}

function requestFor(fetch: Mock<FetchLike>, method: string): { rpc: Rpc; headers: Headers }[] {
  return fetch.mock.calls
    .filter(([, init]) => rpcOf(init).method === method)
    .map(([, init]) => ({ rpc: rpcOf(init), headers: new Headers(init?.headers) }));
}

const DESCRIPTOR = {
  name: "item.created",
  description: "An item was created",
  delivery: ["poll", "webhook"],
  inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
  payloadSchema: { type: "object" },
};

const EMPTY_POLL = { result: { events: [], cursor: "c1", truncated: false, hasMore: false, nextPollMs: 30_000 } };

async function caught(work: Promise<unknown>): Promise<McpEventsError> {
  try {
    await work;
  } catch (error) {
    return error as McpEventsError;
  }
  throw new Error("expected a rejection");
}

describe("era detection", () => {
  it("speaks the modern revision without a handshake when the server answers server/discover", async () => {
    const fetch = server({ era: "modern", events: () => ({ result: { events: [DESCRIPTOR] } }) });

    const listed = await client(fetch).list(TARGET);

    expect(listed).toEqual({ supported: true, events: [DESCRIPTOR] });
    expect(methods(fetch)).toEqual(["server/discover", "events/list"]);
    const [{ rpc, headers }] = requestFor(fetch, "events/list");
    expect(headers.get("mcp-protocol-version")).toBe(MCP_MODERN_PROTOCOL_VERSION);
    expect(rpc.params._meta).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": { extensions: { [MCP_EVENTS_EXTENSION]: {} } },
    });
  });

  it("falls back to an initialize handshake declaring the extension when server/discover is unknown", async () => {
    const fetch = server({ era: "legacy", events: () => ({ result: { events: [DESCRIPTOR] } }) });

    await client(fetch).list(TARGET);

    expect(methods(fetch)).toEqual(["server/discover", "initialize", "notifications/initialized", "events/list"]);
    const [{ rpc }] = requestFor(fetch, "initialize");
    expect(rpc.params.capabilities).toEqual({ extensions: { [MCP_EVENTS_EXTENSION]: {} } });
  });

  it("falls back to the handshake when a legacy transport refuses the modern revision header", async () => {
    const fetch = vi.fn<FetchLike>().mockImplementation(async (url, init) => {
      if (rpcOf(init).method === "server/discover") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Unsupported protocol version: 2026-07-28" }, id: null }), { status: 400 });
      }
      return server({ era: "legacy", events: () => ({ result: { events: [] } }) })(url, init);
    });

    expect(await client(fetch).list(TARGET)).toEqual({ supported: true, events: [] });
  });

  it("reads the earlier draft's top-level events capability as support", async () => {
    const fetch = server({ era: "legacy", capabilities: { events: {} }, events: () => ({ result: { events: [] } }) });

    expect(await client(fetch).list(TARGET)).toEqual({ supported: true, events: [] });
  });

  it("sends no events request to a server that does not advertise the extension", async () => {
    const fetch = server({ era: "legacy", capabilities: { tools: {} }, events: () => EMPTY_POLL });

    const error = await caught(client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: null }));

    expect(error.code).toBe("MCP_EVENTS_UNSUPPORTED");
    expect(methods(fetch)).not.toContain("events/poll");
  });

  it("reports an unsupported server from list instead of throwing", async () => {
    const fetch = server({ era: "modern", capabilities: {} });

    expect(await client(fetch).list(TARGET)).toEqual({ supported: false });
  });

  it("classifies a refused credential at discovery as unauthorized", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response("no", { status: 401 }));

    const error = await caught(client(fetch).list(TARGET));

    expect(error.code).toBe("MCP_EVENTS_UNAUTHORIZED");
    expect(error.httpStatus).toBe(401);
  });
});

describe("events/list", () => {
  it("excludes an event type whose header annotation violates the transport constraints", async () => {
    const broken = { ...DESCRIPTOR, name: "bad.header", inputSchema: { type: "object", properties: { region: { type: "object", "x-mcp-header": "Region" } } } };
    const fetch = server({ era: "modern", events: () => ({ result: { events: [DESCRIPTOR, broken] } }) });

    const listed = await client(fetch).list(TARGET);

    expect(listed.supported && listed.events.map(({ name }) => name)).toEqual(["item.created"]);
  });

  it("follows nextCursor across pages", async () => {
    const fetch = server({
      era: "modern",
      events: (rpc) => (rpc.params.cursor === "p2"
        ? { result: { events: [{ ...DESCRIPTOR, name: "second" }] } }
        : { result: { events: [DESCRIPTOR], nextCursor: "p2" } }),
    });

    const listed = await client(fetch).list(TARGET);

    expect(listed.supported && listed.events.map(({ name }) => name)).toEqual(["item.created", "second"]);
  });

  it("refuses a descriptor with an empty delivery list as an invalid response", async () => {
    const fetch = server({ era: "modern", events: () => ({ result: { events: [{ ...DESCRIPTOR, delivery: [] }] } }) });

    expect((await caught(client(fetch).list(TARGET))).code).toBe("MCP_INVALID_RESPONSE");
  });
});

describe("events/poll", () => {
  it("returns occurrences, defaulting an absent occurrence cursor to null", async () => {
    const fetch = server({
      era: "legacy",
      events: () => ({ result: {
        events: [{ eventId: "e1", name: "item.created", timestamp: "2026-11-21T10:00:00Z", data: { id: 1 } }],
        cursor: "c2", truncated: false, hasMore: true, nextPollMs: 30_000,
      } }),
    });

    const result = await client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: "c1" });

    expect(result).toEqual({
      events: [{ eventId: "e1", name: "item.created", timestamp: "2026-11-21T10:00:00Z", data: { id: 1 }, cursor: null }],
      cursor: "c2", truncated: false, hasMore: true, nextPollMs: 30_000,
    });
  });

  it("drops a nextPollMs that is not a positive integer", async () => {
    const fetch = server({ era: "modern", events: () => ({ result: { ...EMPTY_POLL.result, nextPollMs: -5 } }) });

    const result = await client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: null });

    expect(result).not.toHaveProperty("nextPollMs");
  });

  it("carries the session the legacy handshake minted", async () => {
    const legacy = server({ era: "legacy", events: () => EMPTY_POLL });
    const fetch = vi.fn<FetchLike>().mockImplementation(async (url, init) => {
      const response = await legacy(url, init);
      if (rpcOf(init).method !== "initialize") return response;
      return new Response(await response.text(), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-1" } });
    });

    await client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: null });

    const poll = fetch.mock.calls.find(([, init]) => rpcOf(init).method === "events/poll");
    const headers = new Headers(poll?.[1]?.headers);
    expect(headers.get("mcp-session-id")).toBe("sess-1");
    expect(headers.get("mcp-protocol-version")).toBe("2025-11-25");
  });

  it("names a plain event in Mcp-Name", async () => {
    const fetch = server({ era: "modern", events: () => EMPTY_POLL });

    await client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: null });

    expect(requestFor(fetch, "events/poll")[0].headers.get("mcp-name")).toBe("item.created");
  });

  it("carries a non-ASCII event name in the Base64 sentinel", async () => {
    const fetch = server({ era: "modern", events: () => EMPTY_POLL });

    await client(fetch).poll(TARGET, { name: "événement", arguments: {}, cursor: null });

    const header = requestFor(fetch, "events/poll")[0].headers.get("mcp-name") ?? "";
    expect(header).toMatch(/^=\?base64\?.+\?=$/u);
    const encoded = header.slice("=?base64?".length, -"?=".length);
    expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))).toBe("événement");
  });

  it("re-reads the event type and retries once with mirrored headers after a header mismatch", async () => {
    const fetch = server({
      era: "modern",
      events: (rpc, headers) => {
        if (rpc.method === "events/list") return { result: { events: [DESCRIPTOR] } };
        return headers.get("mcp-param-region") === "us-west1"
          ? EMPTY_POLL
          : frame(rpc.id, { error: { code: -32020, message: "HeaderMismatch" } }, 400);
      },
    });

    const result = await client(fetch).poll(TARGET, { name: "item.created", arguments: { region: "us-west1" }, cursor: null });

    expect(result.cursor).toBe("c1");
    expect(methods(fetch).filter((method) => method.startsWith("events/"))).toEqual(["events/poll", "events/list", "events/poll"]);
  });

  it("reports a server refusal with its JSON-RPC code", async () => {
    const fetch = server({ era: "modern", events: () => ({ error: { code: -32023, message: "NotFound", data: { kind: "event" } } }) });

    const error = await caught(client(fetch).poll(TARGET, { name: "missing", arguments: {}, cursor: null }));

    expect({ code: error.code, rpcCode: error.rpcCode }).toEqual({ code: "MCP_EVENTS_RPC_ERROR", rpcCode: -32023 });
  });

  it("reads the draft numbering ChatGPT-dialect servers answer with as the SEP's code", async () => {
    const fetch = server({ era: "modern", events: () => ({ error: { code: -32012, message: "Forbidden" } }) });

    const error = await caught(client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: null }));

    expect(error.rpcCode).toBe(-32024);
  });

  it("refuses an occurrence without an eventId as an invalid response", async () => {
    const fetch = server({ era: "modern", events: () => ({ result: { ...EMPTY_POLL.result, events: [{ name: "item.created", timestamp: "t", data: {} }] } }) });

    const error = await caught(client(fetch).poll(TARGET, { name: "item.created", arguments: {}, cursor: null }));

    expect(error.code).toBe("MCP_INVALID_RESPONSE");
  });
});

describe("events/subscribe", () => {
  const request = { name: "item.created", arguments: {}, url: "https://hooks.example.com/mcp-events/sub", secret: SECRET, cursor: null };

  it("refuses a secret that is not a Standard Webhooks secret before sending anything", async () => {
    const fetch = server({ era: "modern" });

    const error = await caught(client(fetch).subscribe(TARGET, { ...request, secret: "abc" }));

    expect(error.code).toBe("INVALID_MCP_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a callback that is not https before sending anything", async () => {
    const fetch = server({ era: "modern" });

    const error = await caught(client(fetch).subscribe(TARGET, { ...request, url: "http://hooks.example.com/x" }));

    expect(error.code).toBe("INVALID_MCP_REQUEST");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the webhook delivery and returns the grant", async () => {
    const fetch = server({
      era: "modern",
      events: () => ({ result: { id: "sub_1", refreshBefore: "2026-11-21T11:00:00Z", cursor: "c9", truncated: false, deliveryStatus: { active: true, lastError: null } } }),
    });

    const result = await client(fetch).subscribe(TARGET, { ...request, ttlMs: 3_600_000 });

    expect(result).toEqual({ id: "sub_1", refreshBefore: "2026-11-21T11:00:00Z", cursor: "c9", truncated: false, deliveryStatus: { active: true, lastError: null } });
    expect(requestFor(fetch, "events/subscribe")[0].rpc.params).toMatchObject({
      name: "item.created",
      delivery: { mode: "webhook", url: request.url, secret: SECRET },
      cursor: null,
      ttlMs: 3_600_000,
    });
  });

  it.each(["challenge_failed", "http_4xx", "http_5xx"])("carries the callback failure reason %s", async (reason) => {
    const fetch = server({ era: "modern", events: () => ({ error: { code: -32027, message: "CallbackEndpointError", data: { reason } } }) });

    const error = await caught(client(fetch).subscribe(TARGET, request));

    expect({ rpcCode: error.rpcCode, reason: error.reason }).toEqual({ rpcCode: -32027, reason });
  });

  it("carries the callback failure reason under the draft's CallbackEndpointError code", async () => {
    const fetch = server({ era: "modern", events: () => ({ error: { code: -32015, message: "CallbackEndpointError", data: { reason: "challenge_failed" } } }) });

    const error = await caught(client(fetch).subscribe(TARGET, request));

    expect({ rpcCode: error.rpcCode, reason: error.reason }).toEqual({ rpcCode: -32027, reason: "challenge_failed" });
  });
});

describe("events/unsubscribe", () => {
  it("names the subscription by its key", async () => {
    const fetch = server({ era: "modern", events: () => ({ result: {} }) });

    await client(fetch).unsubscribe(TARGET, { name: "item.created", arguments: { region: "eu" }, url: "https://hooks.example.com/x" });

    expect(requestFor(fetch, "events/unsubscribe")[0].rpc.params).toMatchObject({
      name: "item.created",
      arguments: { region: "eu" },
      delivery: { url: "https://hooks.example.com/x" },
    });
  });
});

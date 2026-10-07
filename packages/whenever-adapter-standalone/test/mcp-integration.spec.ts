import { describe, expect, it, vi } from "vitest";

import { MAX_PROVIDER_DETAIL_LENGTH } from "../src/http";
import {
  createMcpDiscoveryFromEnv,
  createMcpIntegrationFromEnv,
  createWorkflowIntegrationsFromEnv,
  type FetchLike,
  HTTP_REQUEST_BODY_LIMIT_BYTES,
  MCP_ARGUMENTS_REFUSED,
  MCP_INPUT_REJECTED,
  MCP_PROTOCOL_VERSION,
  MCP_TOOL_LIST_UNAUTHORIZED,
  type McpDiscoveryInput,
  type McpIntegrationOptions,
  type McpToolDescriptor,
} from "../src/index";
import { prepareMcpToolCallInput } from "../src/internal";

function jsonRpcResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = { "Content-Type": "application/json" },
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function toolResult(result: unknown, id: number | string = 1): Response {
  return jsonRpcResponse({ jsonrpc: "2.0", id, result });
}

function requestId(init: RequestInit | undefined): number {
  return (JSON.parse(String(init?.body)) as { id: number }).id;
}

function methodOf(init: RequestInit | undefined): string {
  return String((JSON.parse(String(init?.body)) as { method: string }).method);
}

/** The lifecycle the revision requires, so a test can speak only about the call it is about. */
function answersWith(build: (id: number) => Response) {
  return vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
    const method = methodOf(init);
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "initialize") {
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: requestId(init),
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-server", version: "1.0.0" },
        },
      });
    }
    return build(requestId(init));
  });
}

function requestTo(
  fetch: ReturnType<typeof answersWith>,
  method: string,
): RequestInit | undefined {
  return fetch.mock.calls.find(
    ([, init]) => init !== undefined && methodOf(init) === method,
  )?.[1];
}

function context(fetch: FetchLike) {
  return createWorkflowIntegrationsFromEnv({
    fetch,
    resolveHost: async () => ["93.184.216.34"],
  });
}

describe("MCP integration", () => {
  it("calls a tool over Streamable HTTP and returns its structured result", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        {
          resultType: "complete",
          structuredContent: { rows: [{ id: 7 }] },
          content: [{ type: "text", text: "1 row" }],
        },
        id,
      ),
    );

    const result = await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "execute_sql",
      toolProps: { query: "select * from users" },
      headers: { Authorization: "Bearer author-token" },
    });

    expect(result).toEqual({
      structuredContent: { rows: [{ id: 7 }] },
      content: [{ type: "text", text: "1 row" }],
    });

    const init = requestTo(fetch, "tools/call");
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer author-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toContain("text/event-stream");
    expect(headers.get("Mcp-Method")).toBe("tools/call");
    expect(headers.get("Mcp-Name")).toBe("execute_sql");

    expect(JSON.parse(String(init?.body))).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "execute_sql", arguments: { query: "select * from users" } },
    });
  });

  it("reads the envelope out of an event-stream response", async () => {
    const fetch = answersWith((id) => {
      const stream = [
        ": keep-alive",
        "event: message",
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { structuredContent: { ok: true }, content: [] },
        })}`,
        "",
      ].join("\n");
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const result = await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "list_projects",
    });

    expect(result).toEqual({ structuredContent: { ok: true }, content: [] });
  });

  it("throws when the tool itself reports an error", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [{ type: "text", text: "relation \"users\" does not exist" }],
        },
        id,
      ),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "execute_sql",
      }),
    ).rejects.toMatchObject({
      code: "MCP_TOOL_ERROR",
      detail: expect.stringContaining("does not exist"),
    });
  });

  // Measured live against mcp.neon.tech: a missing required argument comes back as a 200 carrying
  // isError, with the reference server's own "MCP error -32602" text naming the argument.
  it("classifies a refusal of the arguments apart from a tool that failed while running", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: "MCP error -32602: Input validation error: Invalid arguments for tool run_sql: project_id Required",
            },
          ],
        },
        id,
      ),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
      }),
    ).rejects.toMatchObject({
      code: MCP_INPUT_REJECTED,
      detail: expect.stringContaining("project_id"),
    });
  });

  it("classifies the same refusal answered as an invalid-params error frame", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Invalid arguments for tool run_sql" },
      }),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
      }),
    ).rejects.toMatchObject({ code: MCP_INPUT_REJECTED });
  });

  // Captured from mcp.neon.tech: `run_sql` requires `project_id`, and every refusal it answers is a
  // 200 carrying isError whose text is the reference validator's own Zod issue array.
  const NEON_REFUSED_THE_ARGUMENTS = [
    "MCP error -32602: Input validation error: Invalid arguments for tool run_sql: [",
    '  {\n    "code": "invalid_type",\n    "expected": "string",',
    '    "received": "undefined",\n    "path": [\n      "project_id"\n    ],',
    '    "message": "Required"\n  },',
    '  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "projectId",',
    '      "extraThing"\n    ],\n    "path": [],',
    "    \"message\": \"Unrecognized key(s) in object: 'projectId', 'extraThing'\"\n  }\n]",
  ].join("\n");

  it("names the arguments a server refused through a tool result", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        { isError: true, content: [{ type: "text", text: NEON_REFUSED_THE_ARGUMENTS }] },
        id,
      ),
    );

    const refusal = await context(fetch)
      .mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
        toolProps: { sql: "select 1", projectId: "p", extraThing: 1 },
      })
      .catch((error: unknown) => error);

    // `isError` is the protocol's channel for every execution failure, so this text cannot place
    // the refusal before the tool body however precisely it names the argument.
    expect(refusal).toMatchObject({ code: MCP_INPUT_REJECTED });
    const detail = String((refusal as { detail?: unknown }).detail);
    expect(detail).toContain("does not accept projectId");
    expect(detail).toContain("requires project_id");
  });

  it("reads a refusal a server put in a later text block than its summary", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [
            { type: "text", text: "The call could not be completed." },
            { type: "text", text: NEON_REFUSED_THE_ARGUMENTS },
          ],
        },
        id,
      ),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
        toolProps: { projectId: "p" },
      }),
    ).rejects.toMatchObject({
      code: MCP_INPUT_REJECTED,
      detail: expect.stringContaining("does not accept projectId"),
    });
  });

  it("reports Neon's plain missing organization reply as an input refusal", async () => {
    const fetch = answersWith((id) => toolResult({
      isError: true,
      content: [{ type: "text", text: "org_id is required, you can find it on your organization settings page" }],
    }, id));
    await expect(context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp", toolName: "list_projects",
    })).rejects.toMatchObject({
      code: MCP_INPUT_REJECTED,
      detail: expect.stringContaining("requires org_id"),
    });
  });

  // The form the older fixture in this file records, which carries no JSON issue array at all.
  it("reads a required argument a server named in prose", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: "MCP error -32602: Input validation error: Invalid arguments for tool run_sql: project_id Required",
            },
          ],
        },
        id,
      ),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
      }),
    ).rejects.toMatchObject({
      code: MCP_INPUT_REJECTED,
      detail: expect.stringContaining("requires project_id"),
    });
  });

  // An error frame instead of a tool result: a conformant server returns a result once the tool
  // body runs, including a failed one, so this is the one shape that places the refusal before it.
  it("calls an invalid-params error frame a refusal that ran nothing", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: NEON_REFUSED_THE_ARGUMENTS },
      }),
    );

    await expect(
      context(fetch).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
        toolProps: { sql: "select 1", projectId: "p" },
      }),
    ).rejects.toMatchObject({
      code: MCP_ARGUMENTS_REFUSED,
      detail: expect.stringContaining("project_id"),
    });
  });

  it("reads a frame that carries its issues in data rather than message", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Invalid params",
          data: { issues: [{ code: "unrecognized_keys", keys: ["projectId"] }] },
        },
      }),
    );

    await expect(
      context(fetch).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
        toolProps: { projectId: "p" },
      }),
    ).rejects.toMatchObject({
      code: MCP_ARGUMENTS_REFUSED,
      detail: expect.stringContaining("does not accept projectId"),
    });
  });

  it("keeps a frame that is not about the arguments off the undispatched code", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Invalid arguments for tool run_sql: project_id Required" },
      }),
    );

    await expect(
      context(fetch).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
      }),
    ).rejects.toMatchObject({ code: MCP_INPUT_REJECTED });
  });

  // "Nothing ran" is only ever said about a refusal that named an argument, because naming one is
  // what places the refusal before the tool body. This refusal describes the call itself.
  it("leaves a refusal that names no argument classified as it was", async () => {
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [
            { type: "text", text: "MCP error -32602: Tool no_such_tool_here not found" },
          ],
        },
        id,
      ),
    );

    await expect(
      context(fetch).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "no_such_tool_here",
      }),
    ).rejects.toMatchObject({ code: MCP_INPUT_REJECTED });
  });

  // A name read out of the server's echo is one the workflow chose. This lane already masks the
  // request body, so the assertion is on the property, not on which masking holds it.
  it("reports no name the call itself put in the request", async () => {
    const forged =
      'SELECT 1 /* {"path":["admin_override"],"message":"Required"} */';
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Input validation error: Invalid arguments for tool run_sql: " +
                '[{"code":"unrecognized_keys","keys":["projectId"],"path":[]}] ' +
                `received sql='${forged}'`,
            },
          ],
        },
        id,
      ),
    );

    const refusal = await context(fetch)
      .mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
        toolProps: { sql: forged, projectId: "p" },
      })
      .catch((error: unknown) => error);

    const detail = String((refusal as { detail?: unknown }).detail);
    expect(detail).toContain("does not accept projectId");
    expect(detail).not.toContain("admin_override");
  });

  it("never reports a name that is the credential this call presented", async () => {
    const presented = "neon_api_key_9f3ab7c2e5d14086";
    const fetch = answersWith((id) =>
      toolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Input validation error: Invalid arguments for tool run_sql: " +
                `[{"code":"unrecognized_keys","keys":["${presented}","projectId"],"path":[]}]`,
            },
          ],
        },
        id,
      ),
    );

    const refusal = await context(fetch)
      .mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "run_sql",
        headers: { Authorization: `Bearer ${presented}` },
      })
      .catch((error: unknown) => error);

    const detail = String((refusal as { detail?: unknown }).detail);
    expect(detail).toContain("projectId");
    expect(detail).not.toContain(presented);
  });

  it("throws when the server refuses the call at the protocol layer", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unknown tool: execute_sql" },
      }),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "execute_sql",
      }),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CALL_REFUSED" });
  });

  it("keeps a read retryable but never replays a write whose outcome is unknown", async () => {
    const droppedOnDispatch = () =>
      vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
        const method = methodOf(init);
        if (method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (method === "initialize") {
          return jsonRpcResponse({
            jsonrpc: "2.0",
            id: requestId(init),
            result: { protocolVersion: MCP_PROTOCOL_VERSION },
          });
        }
        throw new Error("socket hang up");
      });

    await expect(
      context(droppedOnDispatch()).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "list_projects",
      }),
    ).rejects.toMatchObject({ code: "MCP_TOOL_CALL_FAILED", retryable: true });

    await expect(
      context(droppedOnDispatch()).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "insert_row",
      }),
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_EXTERNAL_WRITE",
      retryable: false,
    });
  });

  it("dispatches no write at all when the server never finished the handshake", async () => {
    const unreachable = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error("socket hang up"));

    await expect(
      context(unreachable).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "insert_row",
      }),
    ).rejects.toMatchObject({ code: "MCP_INITIALIZE_FAILED" });

    // A failed handshake must prevent tool dispatch.
    expect(
      unreachable.mock.calls.every(
        ([, init]) => methodOf(init) === "initialize",
      ),
    ).toBe(true);
  });

  it("refuses a server address the egress guard blocks", async () => {
    const fetch = vi.fn<FetchLike>();

    await expect(
      context(fetch).mcp.read({
        url: "http://169.254.169.254/mcp",
        toolName: "whoami",
      }),
    ).rejects.toMatchObject({ code: "HTTP_EGRESS_BLOCKED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores stream frames that are not this call's response", async () => {
    const fetch = answersWith((id) => {
      const stream = [
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })}`,
        "",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { structuredContent: { rows: 1 } } })}`,
        "",
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}`,
        "",
        "data: {}",
        "",
      ].join("\n");
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const result = await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "count_rows",
    });

    expect(result.structuredContent).toEqual({ rows: 1 });
  });

  it("reassembles an envelope split across several data lines", async () => {
    const fetch = answersWith((id) => {
      const pretty = JSON.stringify(
        { jsonrpc: "2.0", id, result: { structuredContent: { ok: true } } },
        null,
        2,
      );
      const stream = `${pretty
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n")}\n\n`;
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const result = await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "ping",
    });

    expect(result.structuredContent).toEqual({ ok: true });
  });

  it("refuses a response that answers a different request id", async () => {
    const fetch = answersWith((id) =>
      toolResult({ structuredContent: { ok: true } }, id + 1000),
    );

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "ping",
      }),
    ).rejects.toMatchObject({ code: "MCP_INVALID_RESPONSE" });
  });

  it("refuses a result whose isError flag is not a boolean", async () => {
    const fetch = answersWith((id) =>
      toolResult({ isError: "true", content: [{ type: "text", text: "no" }] }, id),
    );

    await expect(
      context(fetch).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "insert_row",
      }),
    ).rejects.toMatchObject({ code: "MCP_INVALID_RESPONSE" });
  });

  it("masks a credential the server echoes back in a tool error", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "rejected key 9f3c7d1e4b8a2f6019" },
      }),
    );

    const failure = await context(fetch)
      .mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "execute_sql",
        headers: { "X-Api-Key": "9f3c7d1e4b8a2f6019" },
      })
      .then(
        () => {
          throw new Error("the call resolved, so there is no refusal to inspect");
        },
        (error: unknown) => error as Error & { detail?: string },
      );

    expect(failure.detail).not.toContain("9f3c7d1e4b8a2f6019");
    expect(failure.message).not.toContain("9f3c7d1e4b8a2f6019");
  });

  it("refuses a result that carries neither structured output nor content", async () => {
    const fetch = answersWith((id) => toolResult({}, id));

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "count_rows",
      }),
    ).rejects.toMatchObject({ code: "MCP_INVALID_RESPONSE" });
  });

  it("accepts a result that carries only content", async () => {
    const fetch = answersWith((id) =>
      toolResult({ content: [{ type: "text", text: "done" }] }, id),
    );

    const result = await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "count_rows",
    });

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result.structuredContent).toBeUndefined();
  });

  it("sends the whole per-request _meta envelope the revision requires", async () => {
    const fetch = answersWith((id) =>
      toolResult({ structuredContent: { ok: true } }, id),
    );

    await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "probe",
    });

    const meta = (
      JSON.parse(String(requestTo(fetch, "tools/call")?.body)) as {
        params: { _meta: Record<string, unknown> };
      }
    ).params._meta;

    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe(
      MCP_PROTOCOL_VERSION,
    );
    expect(meta).toHaveProperty("io.modelcontextprotocol/clientCapabilities");
    expect(meta).toHaveProperty("io.modelcontextprotocol/clientInfo");
  });

  it("names the field when toolProps carries a value JSON cannot encode", async () => {
    const fetch = vi.fn<FetchLike>();

    let refusal: Error | undefined;
    try {
      await context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "execute_sql",
        toolProps: { topic: undefined, query: "select 1" },
      });
    } catch (error) {
      refusal = error as Error;
    }

    expect(refusal?.message).toContain("toolProps.topic is undefined");
    expect(fetch).not.toHaveBeenCalled();
  });

  // A write resent on the strength of a refusal we cannot prove came before dispatch would apply
  // twice, which the package's own rule forbids.
  it("refuses a call that names no tool", async () => {
    const fetch = vi.fn<FetchLike>();

    await expect(
      context(fetch).mcp.read({
        url: "https://mcp.example.com/mcp",
        toolName: "  ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_MCP_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("MCP protocol lifecycle", () => {
  interface FakeServer {
    negotiatedVersion?: string;
    sessionId?: string;
    dropSessionOnce?: boolean;
    emptyInitializeResult?: boolean;
    supportedVersions?: readonly string[];
    refuseInitialize?: { code: number; message: string; data?: unknown };
    tools?: readonly { name: string }[];
  }

  interface SeenRequest {
    method: string;
    version: string | null;
    session: string | null;
    body: Record<string, unknown>;
  }

  function fakeMcpServer(options: FakeServer = {}): {
    fetch: FetchLike;
    seen: SeenRequest[];
  } {
    const seen: SeenRequest[] = [];
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      const method = String(body.method);
      seen.push({
        method,
        version: headers.get("mcp-protocol-version"),
        session: headers.get("mcp-session-id"),
        body,
      });

      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      if (method === "initialize") {
        if (options.refuseInitialize !== undefined) {
          return jsonRpcResponse(
            { jsonrpc: "2.0", id: body.id, error: options.refuseInitialize },
            400,
          );
        }
        const offered = (body.params as { protocolVersion?: string })
          .protocolVersion;
        const supported = options.supportedVersions;
        if (supported !== undefined && !supported.includes(String(offered))) {
          return jsonRpcResponse(
            {
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: -32000,
                message: `Bad Request: Unsupported protocol version: ${String(offered)} (supported versions: ${supported.join(", ")})`,
              },
            },
            400,
          );
        }
        if (options.emptyInitializeResult === true) {
          return jsonRpcResponse({ jsonrpc: "2.0", id: body.id, result: {} });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: options.negotiatedVersion ?? offered,
              capabilities: { tools: {} },
              serverInfo: { name: "fake-server", version: "1.0.0" },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...(options.sessionId === undefined
                ? {}
                : { "Mcp-Session-Id": options.sessionId }),
            },
          },
        );
      }

      if (method === "tools/call" && options.dropSessionOnce === true) {
        options.dropSessionOnce = false;
        return jsonRpcResponse(
          { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Session not found" } },
          404,
        );
      }

      if (method === "tools/list") {
        return toolResult(
          { tools: options.tools ?? [{ name: "run_sql" }] },
          body.id as number,
        );
      }

      return toolResult(
        { structuredContent: { ok: true }, content: [] },
        body.id as number,
      );
    });
    return { fetch, seen };
  }

  const readTool = async (fetch: FetchLike): Promise<unknown> =>
    await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "run_sql",
      toolProps: { sql: "select 1" },
      headers: { Authorization: "Bearer author-token" },
    });

  it("initializes the server before it calls a tool, then says it is initialized", async () => {
    const { fetch, seen } = fakeMcpServer();

    await readTool(fetch);

    expect(seen.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });

  it("speaks the revision the server negotiated rather than the one it offered", async () => {
    const { fetch, seen } = fakeMcpServer({
      negotiatedVersion: "2025-11-25",
    });

    await readTool(fetch);

    const call = seen.find((request) => request.method === "tools/call");
    expect(call?.version).toBe("2025-11-25");
  });

  it("refuses a revision the server chose that this client does not read", async () => {
    // 2025-03-26 addresses a request the same way but may answer with a batched array.
    const { fetch, seen } = fakeMcpServer({ negotiatedVersion: "2025-03-26" });

    await expect(readTool(fetch)).rejects.toMatchObject({
      code: "MCP_VERSION_UNSUPPORTED",
    });
    expect(seen.map((request) => request.method)).not.toContain("tools/call");
  });

  it("carries a session the server minted on every later request", async () => {
    const { fetch, seen } = fakeMcpServer({ sessionId: "session-42" });

    await readTool(fetch);

    expect(
      seen
        .filter((request) => request.method !== "initialize")
        .map((request) => request.session),
    ).toEqual(["session-42", "session-42"]);
  });

  it("sends no session header at all when the server mints none", async () => {
    const { fetch, seen } = fakeMcpServer();

    await readTool(fetch);

    expect(seen.every((request) => request.session === null)).toBe(true);
  });

  it("retries with a revision the server named when it refuses the offered one", async () => {
    const { fetch, seen } = fakeMcpServer({
      supportedVersions: ["2025-11-25", "2025-03-26"],
    });

    await readTool(fetch);

    const initializes = seen.filter(
      (request) => request.method === "initialize",
    );
    expect(initializes).toHaveLength(2);
    expect(
      (initializes[1]!.body.params as { protocolVersion?: string })
        .protocolVersion,
    ).toBe("2025-11-25");
    expect(seen.map((request) => request.method)).toContain("tools/call");
  });

  it("never dispatches the tool when the server refuses to initialize", async () => {
    const { fetch, seen } = fakeMcpServer({
      refuseInitialize: { code: -32603, message: "server is unavailable" },
    });

    await expect(readTool(fetch)).rejects.toMatchObject({
      code: "MCP_INITIALIZE_FAILED",
    });
    expect(seen.map((request) => request.method)).not.toContain("tools/call");
  });

  it("refuses to initialize twice for a refusal that is not about the revision", async () => {
    const { fetch, seen } = fakeMcpServer({
      refuseInitialize: {
        code: -32000,
        message: "Forbidden",
        data: { supported: ["2025-11-25"] },
      },
    });

    await expect(readTool(fetch)).rejects.toMatchObject({
      code: "MCP_INITIALIZE_FAILED",
    });
    expect(
      seen.filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
  });

  it("quotes none of a refusal's own text back into the failure it reports", async () => {
    const { fetch } = fakeMcpServer({
      refuseInitialize: {
        code: -32000,
        message: "Unsupported protocol version",
        data: { supported: ["plainproviderpasswordvalue"] },
      },
    });

    let refusal: Error | undefined;
    try {
      await readTool(fetch);
    } catch (error) {
      refusal = error as Error;
    }
    expect(refusal?.message).not.toContain("plainproviderpasswordvalue");
  });

  it("drops a session header the author supplied, having opened none", async () => {
    const { fetch, seen } = fakeMcpServer();

    await context(fetch).mcp.read({
      url: "https://mcp.example.com/mcp",
      toolName: "run_sql",
      toolProps: { sql: "select 1" },
      headers: {
        Authorization: "Bearer author-token",
        "Mcp-Session-Id": "stale-author-session",
      },
    });

    expect(seen.every((request) => request.session === null)).toBe(true);
  });

  it("names the negotiated revision in the body as well as the header", async () => {
    const { fetch, seen } = fakeMcpServer({
      negotiatedVersion: "2025-11-25",
    });

    await readTool(fetch);

    const call = seen.find((request) => request.method === "tools/call");
    const meta = (
      call?.body.params as { _meta: Record<string, unknown> } | undefined
    )?._meta;
    // The transport rejects a request whose header and _meta disagree.
    expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe(
      "2025-11-25",
    );
    expect(call?.version).toBe("2025-11-25");
  });

  it("refuses a handshake that names no revision at all", async () => {
    const { fetch, seen } = fakeMcpServer({ emptyInitializeResult: true });

    await expect(readTool(fetch)).rejects.toMatchObject({
      code: "MCP_INVALID_RESPONSE",
    });
    expect(seen.map((request) => request.method)).not.toContain("tools/call");
  });

  it("opens a new session and repeats a read the server 404s", async () => {
    const { fetch, seen } = fakeMcpServer({
      sessionId: "session-1",
      dropSessionOnce: true,
    });

    await readTool(fetch);

    expect(
      seen.filter((request) => request.method === "initialize"),
    ).toHaveLength(2);
    const calls = seen.filter((request) => request.method === "tools/call");
    expect(calls).toHaveLength(2);
    // The reopened session is the one the repeat is made under, not the dropped one.
    expect(calls[1]?.session).toBe("session-1");
  });

  it("never repeats a write the server 404s", async () => {
    const { fetch, seen } = fakeMcpServer({
      sessionId: "session-1",
      dropSessionOnce: true,
    });

    await expect(
      context(fetch).mcp.write({
        url: "https://mcp.example.com/mcp",
        toolName: "insert_row",
        headers: { Authorization: "Bearer author-token" },
      }),
      // A 404 refuses without applying, so this is a plain refusal rather than an ambiguous
      // write. What matters is that it is not sent twice.
    ).rejects.toMatchObject({ code: "MCP_TOOL_CALL_FAILED" });
    expect(
      seen.filter((request) => request.method === "tools/call"),
    ).toHaveLength(1);
  });

  it("handshakes over the probe fetch and dispatches over the other", async () => {
    const { fetch: server } = fakeMcpServer();
    const probed: string[] = [];
    const dispatched: string[] = [];
    const record = (log: string[]): FetchLike => async (input, init) => {
      log.push(methodOf(init));
      return await server(input, init);
    };

    await createWorkflowIntegrationsFromEnv({
      fetch: record(dispatched),
      probeFetch: record(probed),
      resolveHost: async () => ["93.184.216.34"],
    }).mcp.write({
      url: "https://mcp.example.com/mcp",
      toolName: "insert_row",
      toolProps: { value: 1 },
      headers: { Authorization: "Bearer author-token" },
    });

    // A caller that reads mutation evidence off the requests it observes must not see a handshake.
    expect(probed).toEqual(["initialize", "notifications/initialized"]);
    expect(dispatched).toEqual(["tools/call"]);
  });

  // Publishing has to tell "the credential we withheld was needed" apart from "that address does
  // not serve MCP": only the first names a repair, and only 401 and 403 establish it.
  it("classifies a listing refused for authorization apart from every other refusal", async () => {
    const refusing = (status: number): FetchLike =>
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "invalid_token",
              error_description: "No authorization provided",
            }),
            { status, headers: { "Content-Type": "application/json" } },
          ),
      );
    const listing = (status: number): Promise<unknown> =>
      createMcpDiscoveryFromEnv({
        fetch: refusing(status),
        resolveHost: async () => ["93.184.216.34"],
      })({ url: "https://mcp.example.com/mcp" });

    for (const status of [401, 403]) {
      await expect(listing(status)).rejects.toMatchObject({
        code: MCP_TOOL_LIST_UNAUTHORIZED,
        retryable: false,
      });
    }
    for (const status of [400, 404, 405]) {
      await expect(listing(status)).rejects.not.toMatchObject({
        code: MCP_TOOL_LIST_UNAUTHORIZED,
      });
    }
  });

  it("classifies an authorization refusal of the listing itself, past the handshake", async () => {
    const fetch = answersWith(
      () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      createMcpDiscoveryFromEnv({
        fetch,
        resolveHost: async () => ["93.184.216.34"],
      })({ url: "https://mcp.example.com/mcp" }),
    ).rejects.toMatchObject({ code: MCP_TOOL_LIST_UNAUTHORIZED });
  });

  // The narrowing belongs to discovery alone. A run-time tool call answered 401 must keep its own
  // classification: "refused to list its tools" is the wrong cause, under a code a caller may not
  // know, for a call that never listed anything.
  it("leaves a tool call's own authorization failure classified as it was", async () => {
    const refusing: FetchLike = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    for (const call of ["read", "write"] as const) {
      await expect(
        createWorkflowIntegrationsFromEnv({
          fetch: refusing,
          resolveHost: async () => ["93.184.216.34"],
        }).mcp[call]({
          url: "https://mcp.example.com/mcp",
          toolName: "run_sql",
        }),
      ).rejects.not.toMatchObject({ code: MCP_TOOL_LIST_UNAUTHORIZED });
    }
  });

  it("initializes once for a discovery that reads several pages", async () => {
    const { fetch, seen } = fakeMcpServer();

    const discovery = createMcpDiscoveryFromEnv({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
    });
    await discovery({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer author-token" },
    });

    expect(
      seen.filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
    expect(seen.map((request) => request.method)).toContain("tools/list");
  });
});

describe("mcp discovery says when it could not read a tool's arguments", () => {
  const listing = async (
    tools: unknown[],
  ): Promise<{ props: unknown[]; propsUnreadable?: true }[]> => {
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const method = methodOf(init);
      if (method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (method === "initialize") {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: requestId(init),
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "fake-server", version: "1.0.0" },
          },
        });
      }
      return toolResult({ tools }, requestId(init));
    });
    return (await createMcpDiscoveryFromEnv({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
    })({ url: "https://mcp.example.com/mcp" })) as {
      props: unknown[];
      propsUnreadable?: true;
      acceptsExtraProps?: true;
    }[];
  };

  it("reads the arguments a server declares at the root of its input schema", async () => {
    const [tool] = await listing([
      {
        name: "run_sql",
        inputSchema: {
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
        },
      },
    ]);

    expect(tool).toMatchObject({
      props: [{ name: "sql", type: "string", required: true }],
    });
    expect(tool).not.toHaveProperty("propsUnreadable");
  });

  it("calls a tool declaring an empty property set one that takes no arguments", async () => {
    for (const inputSchema of [
      { type: "object", properties: {} },
      // No properties key, but closed: it accepts nothing, which is a readable answer and not the
      // same as a schema that never says. Reporting it unreadable would let a bogus argument pass.
      { type: "object", additionalProperties: false },
    ]) {
      const [tool] = await listing([{ name: "list_projects", inputSchema }]);

      expect(tool?.props).toEqual([]);
      expect(tool).not.toHaveProperty("propsUnreadable");
    }
  });

  // A schema behind $ref or allOf has arguments this reader cannot see, and reporting none would
  // make every argument the workflow passes look like one the tool does not take.
  it("does not report a schema it cannot follow as a tool taking no arguments", async () => {
    for (const inputSchema of [
      { $ref: "#/definitions/RunSql" },
      { allOf: [{ $ref: "#/definitions/RunSql" }] },
      { anyOf: [{ type: "object" }] },
      { oneOf: [{ type: "object" }] },
      // Open: any argument is permitted, so no argument can be called one the tool does not take.
      { type: "object" },
      undefined,
    ]) {
      const [tool] = await listing([{ name: "run_sql", inputSchema }]);

      expect(tool).toMatchObject({ props: [], propsUnreadable: true });
    }
  });

  // Only `false` closes a schema. Absent permits extras, and so does a schema describing what an
  // extra must look like, so neither makes the declared list the whole one.
  it("treats every schema but an explicitly closed one as taking more than it names", async () => {
    for (const additionalProperties of [
      undefined,
      true,
      { type: "string" },
      {},
    ]) {
      const [tool] = await listing([
        {
          name: "run_sql",
          inputSchema: {
            type: "object",
            properties: { sql: { type: "string" } },
            required: ["sql"],
            ...(additionalProperties === undefined ? {} : { additionalProperties }),
          },
        },
      ]);

      expect(tool).toMatchObject({
        props: [{ name: "sql", type: "string", required: true }],
        acceptsExtraProps: true,
      });
    }
  });

  it("reports a closed schema as taking only what it names", async () => {
    const [tool] = await listing([
      {
        name: "run_sql",
        inputSchema: {
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
          additionalProperties: false,
        },
      },
    ]);

    expect(tool).not.toHaveProperty("acceptsExtraProps");
  });

  // The half a reference defers is invisible, so root properties are not the whole argument list.
  it("does not read root properties as the whole list when a reference defers the rest", async () => {
    const [tool] = await listing([
      {
        name: "run_sql",
        inputSchema: {
          type: "object",
          properties: { sql: { type: "string" } },
          required: ["sql"],
          allOf: [{ $ref: "#/definitions/ProjectScoped" }],
        },
      },
    ]);

    expect(tool).toMatchObject({ propsUnreadable: true });
  });
});

const SERVER = "https://mcp.example.com/mcp";
const URL_MISSING = "url must be a non-empty string";

interface Refusal {
  code: string;
  message: string;
  retryable: unknown;
  calls: number;
}

/** Driven through the port, so a rule only holds if the port is the thing that applies it. */
async function refusalFor(input: unknown): Promise<Refusal> {
  const fetch = vi.fn<FetchLike>();
  try {
    await context(fetch).mcp.read(input as never);
    return {
      code: "accepted",
      message: "accepted",
      retryable: "absent",
      calls: fetch.mock.calls.length,
    };
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
      calls: fetch.mock.calls.length,
    };
  }
}

/** The same call against a server that answers, so an acceptance is observable as one. */
async function outcomeOf(input: unknown): Promise<string> {
  const fetch = answersWith((id) =>
    toolResult({ structuredContent: { ok: true } }, id),
  );
  try {
    await context(fetch).mcp.read(input as never);
    return "accepted";
  } catch (error) {
    return error instanceof Error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "none";
  }
}

describe("mcp.* refuses a call before it opens a session", () => {
  it("accepts the smallest call a workflow can make", async () => {
    expect(await outcomeOf({ url: SERVER, toolName: "ping" })).toBe("accepted");
  });

  // A workflow may hold its arguments on a prototype-less object, which is a record by every test
  // that matters. Refusing it would refuse a value JSON.parse itself produces with __proto__.
  it("accepts a call carried on an object with no prototype", async () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.url = SERVER;
    bare.toolName = "ping";

    expect(await outcomeOf(bare)).toBe("accepted");
  });

  it.each([
    ["a call that is not an object", null],
    ["a call given as an array", [{ url: SERVER, toolName: "ping" }]],
    [
      "a call given as a class instance",
      new (class {
        url = SERVER;
        toolName = "ping";
      })(),
    ],
  ])("makes no request for %s", async (_case, input) => {
    const outcome = await refusalFor(input);

    expect(outcome.code).toBe("INVALID_MCP_REQUEST");
    expect(outcome.retryable).toBe(false);
    expect(outcome.calls).toBe(0);
  });

  it.each([
    ["no url at all", { toolName: "ping" }, URL_MISSING],
    ["a url that is not a string", { url: 3, toolName: "ping" }, URL_MISSING],
    [
      "a url that is only whitespace",
      { url: "   ", toolName: "ping" },
      URL_MISSING,
    ],
    ["no tool name at all", { url: SERVER }, "toolName must be a non-empty string"],
    [
      "a tool name that is not a string",
      { url: SERVER, toolName: 7 },
      "toolName must be a non-empty string",
    ],
    [
      "a tool name that is only whitespace",
      { url: SERVER, toolName: " \t " },
      "toolName must be a non-empty string",
    ],
    [
      "arguments given as an array",
      { url: SERVER, toolName: "ping", toolProps: [1, 2] },
      "toolProps must be an object",
    ],
    [
      "arguments given as a string",
      { url: SERVER, toolName: "ping", toolProps: "sql=select 1" },
      "toolProps must be an object",
    ],
    [
      "headers given as a string",
      { url: SERVER, toolName: "ping", headers: "Authorization: Bearer t" },
      "headers must be an object of strings",
    ],
    [
      "a header with no name",
      { url: SERVER, toolName: "ping", headers: { "   ": "value" } },
      "headers must contain non-empty names and string values",
    ],
    [
      "a header value that is not a string",
      { url: SERVER, toolName: "ping", headers: { "x-key": 7 } },
      "headers must contain non-empty names and string values",
    ],
    [
      "a header name the HTTP grammar forbids",
      { url: SERVER, toolName: "ping", headers: { "x api key": "value" } },
      "headers contain an invalid HTTP header",
    ],
    [
      "a url that is not an address",
      { url: "mcp.example.com/mcp", toolName: "ping" },
      "url is not a usable address",
    ],
  ])(
    "says what is wrong and makes no request for %s",
    async (_case, input, clause) => {
      const outcome = await refusalFor(input);

      expect(outcome.code).toBe("INVALID_MCP_REQUEST");
      expect(outcome.retryable).toBe(false);
      expect(outcome.calls).toBe(0);
      // Naming the field is not enough. An author who left the url out and one who wrote a
      // malformed one have to fix different things, and the parser would refuse both.
      expect(outcome.message).toContain(clause);
    },
  );

  // The guarded fetch refuses a blocked address too, so inside this package the check in the
  // validator is invisible. It is the only one on the path the integrations package takes, which
  // calls this to validate a call it never sends.
  it("refuses a blocked address while validating a call it does not send", () => {
    expect(() =>
      prepareMcpToolCallInput({
        url: "http://169.254.169.254/mcp",
        toolName: "whoami",
      }),
    ).toThrow(/not allowed/u);
  });
});

describe("what a workflow may put in an mcp tool call", () => {
  const argumentsSent = async (
    toolProps: Record<string, unknown>,
  ): Promise<unknown> => {
    const fetch = answersWith((id) =>
      toolResult({ structuredContent: { ok: true } }, id),
    );
    await context(fetch).mcp.read({ url: SERVER, toolName: "ping", toolProps });
    const init = requestTo(fetch, "tools/call");
    return (
      JSON.parse(String(init?.body)) as {
        params: { arguments: unknown };
      }
    ).params.arguments;
  };

  it("sends the arguments a call declared", async () => {
    expect(await argumentsSent({ sql: "select 1" })).toEqual({
      sql: "select 1",
    });
  });

  // No mutation of this file can produce the defect: without the snapshot the walk hands the
  // caller's object to JSON.stringify, whose throw leaves the port without a classification.
  it("refuses an argument that throws when it is read", async () => {
    const toolProps = {
      get token(): string {
        throw new Error("not yours");
      },
    };

    const outcome = await refusalFor({ url: SERVER, toolName: "ping", toolProps });

    expect(outcome.code).toBe("INVALID_MCP_REQUEST");
    expect(outcome.retryable).toBe(false);
    expect(outcome.calls).toBe(0);
    // The walk could not say where it refused, so it states the rule rather than a guess.
    expect(outcome.message).not.toContain("undefined");
  });

  it.each([
    ["a value JSON cannot describe", { at: () => "now" }],
    ["a value outside JSON's number range", { at: 10n }],
    ["a symbol", { at: Symbol("at") }],
  ])("refuses %s among the arguments", async (_case, toolProps) => {
    const outcome = await refusalFor({ url: SERVER, toolName: "ping", toolProps });

    expect(outcome.code).toBe("INVALID_MCP_REQUEST");
    expect(outcome.message).toContain("toolProps");
    expect(outcome.calls).toBe(0);
  });

  it("refuses arguments that refer back to themselves", async () => {
    const toolProps: Record<string, unknown> = {};
    toolProps.self = toolProps;

    const outcome = await refusalFor({ url: SERVER, toolName: "ping", toolProps });

    expect(outcome.code).toBe("INVALID_MCP_REQUEST");
    expect(outcome.calls).toBe(0);
  });

  // The request cap is a transport limit, not a default: a body this big is refused here rather
  // than handed to a server that would have to read it to reject it.
  it("refuses a call whose arguments exceed the request body limit", async () => {
    const outcome = await refusalFor({
      url: SERVER,
      toolName: "ping",
      toolProps: { blob: "x".repeat(HTTP_REQUEST_BODY_LIMIT_BYTES) },
    });

    expect(outcome.code).toBe("INVALID_MCP_REQUEST");
    expect(outcome.message).toContain("tool call exceeds 1 MiB");
    expect(outcome.calls).toBe(0);
  });

  // The cap is a maximum, so a body of exactly that many bytes has to be sent rather than refused.
  // Sized by measuring, because the envelope around the arguments counts toward it.
  it("accepts a call whose body is exactly the request body limit", () => {
    const sized = (blob: string): number =>
      new TextEncoder().encode(
        prepareMcpToolCallInput({ url: SERVER, toolName: "ping", toolProps: { blob } })
          .body,
      ).byteLength;

    let size = HTTP_REQUEST_BODY_LIMIT_BYTES - 4096;
    let measured = 0;
    for (
      let attempt = 0;
      attempt < 6 && measured !== HTTP_REQUEST_BODY_LIMIT_BYTES;
      attempt += 1
    ) {
      measured = sized("x".repeat(size));
      size += HTTP_REQUEST_BODY_LIMIT_BYTES - measured;
    }

    expect(measured).toBe(HTTP_REQUEST_BODY_LIMIT_BYTES);
  });
});

describe("which frame in a stream answers the call", () => {
  interface StreamOutcome {
    code: string;
    note: unknown;
  }

  const reading = async (
    stream: (id: number) => string,
  ): Promise<StreamOutcome> => {
    const fetch = answersWith(
      (id) =>
        new Response(stream(id), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    try {
      const result = await context(fetch).mcp.read({
        url: SERVER,
        toolName: "ping",
      });
      return {
        code: "read",
        note: (result.structuredContent as { note?: unknown } | undefined)?.note,
      };
    } catch (error) {
      return {
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "none",
        note: undefined,
      };
    }
  };

  const answer = (id: number, note: string): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { structuredContent: { note } },
    });

  it("reads an event whose lines end in CRLF", async () => {
    expect(
      await reading((id) => `data: ${answer(id, "ok")}\r\n\r\n`),
    ).toEqual({ code: "read", note: "ok" });
  });

  // Only the one space the field separator allows is dropped. Taking any space would rewrite a
  // value the server sent.
  it("keeps the spaces inside a payload written without one after the colon", async () => {
    expect(await reading((id) => `data:${answer(id, "two words")}\n\n`)).toEqual(
      { code: "read", note: "two words" },
    );
  });

  // SSE joins the data lines of one event with a newline, which a JSON string cannot contain, so
  // this is not a frame at all. Splicing the halves would read a value the server never sent.
  it("does not splice a value a server split across two data lines", async () => {
    expect(
      await reading(
        (id) =>
          [
            `data:{"jsonrpc":"2.0","id":${String(id)},"result":{"structuredContent":{"note":"two`,
            'data:words"}}}',
            "",
            "",
          ].join("\n"),
      ),
    ).toMatchObject({ code: "MCP_INVALID_RESPONSE" });
  });

  it("reads past an event whose payload is not JSON", async () => {
    expect(
      await reading(
        (id) => `data:not json at all\n\ndata: ${answer(id, "ok")}\n\n`,
      ),
    ).toEqual({ code: "read", note: "ok" });
  });

  it("reads past an event that carries no data line", async () => {
    expect(
      await reading(
        (id) => `: keep-alive\nevent: ping\n\ndata: ${answer(id, "ok")}\n\n`,
      ),
    ).toEqual({ code: "read", note: "ok" });
  });

  it.each([
    ["is a bare string", '"hello"'],
    ["is null", "null"],
    ["is a number", "7"],
  ])("reads past a frame that %s", async (_case, frame) => {
    expect(
      await reading((id) => `data: ${frame}\n\ndata: ${answer(id, "ok")}\n\n`),
    ).toEqual({ code: "read", note: "ok" });
  });

  // A frame naming a method is a request or a notification of the server's own, never an answer,
  // whatever else it carries. Reading one would report the server's own words as the tool's result.
  it("reads past a request of the server's own carrying this call's id", async () => {
    expect(
      await reading(
        (id) =>
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "roots/list",
            result: { structuredContent: { note: "forged" } },
          })}\n\ndata: ${answer(id, "ok")}\n\n`,
      ),
    ).toEqual({ code: "read", note: "ok" });
  });

  it("reads past a frame carrying neither a result nor an error", async () => {
    expect(
      await reading(
        (id) =>
          `data: ${JSON.stringify({ jsonrpc: "2.0", id })}\n\ndata: ${answer(id, "ok")}\n\n`,
      ),
    ).toEqual({ code: "read", note: "ok" });
  });

  it("refuses a stream that answers nothing", async () => {
    expect(await reading(() => ": keep-alive\n\n")).toMatchObject({
      code: "MCP_INVALID_RESPONSE",
    });
  });
});

describe("how much of a server's own account of a failure is carried back", () => {
  const failing = async (
    result: unknown,
  ): Promise<{ code: string; detail: unknown; message: string }> => {
    const fetch = answersWith((id) => toolResult(result, id));
    try {
      await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      return { code: "read", detail: undefined, message: "read" };
    } catch (error) {
      const seen = error as { code?: unknown; detail?: unknown };
      return {
        code: String(seen.code),
        // The error class declares the field, so absence reads as undefined rather than missing.
        detail: seen.detail === undefined ? "absent" : seen.detail,
        message: error instanceof Error ? error.message : "unknown",
      };
    }
  };

  const reportedBy = (
    text: string,
  ): Promise<{ code: string; detail: unknown; message: string }> =>
    failing({ isError: true, content: [{ type: "text", text }] });

  // The cap is what keeps a server's prose from becoming the whole run record.
  it("carries no more of a long report than the detail limit allows", async () => {
    const { detail } = await reportedBy("z".repeat(4000));

    expect(String(detail)).toHaveLength(MAX_PROVIDER_DETAIL_LENGTH);
  });

  it.each([
    ["a report that is empty", ""],
    ["a report that is only whitespace", "   \t  "],
  ])("carries no detail at all for %s", async (_case, text) => {
    const outcome = await reportedBy(text);

    expect(outcome.code).toBe("MCP_TOOL_ERROR");
    expect(outcome.detail).toBe("absent");
  });

  it.each([
    ["written as prose", "it went wrong"],
    ["written as a number", 7],
    ["written as an object", { text: "it went wrong" }],
  ])("carries no detail when the content is %s", async (_case, content) => {
    const outcome = await failing({ isError: true, content });

    expect(outcome.code).toBe("MCP_TOOL_ERROR");
    expect(outcome.detail).toBe("absent");
  });

  it("reads the first block that carries text, not the first block", async () => {
    const outcome = await failing({
      isError: true,
      content: [
        { type: "image", data: "aGk=" },
        { type: "text", text: "the query timed out" },
      ],
    });

    expect(outcome.detail).toContain("the query timed out");
  });

  const REFUSES_THE_ARGUMENTS =
    "org_id is required, you can find it on your organization settings page";

  // Every text block is read rather than the first, but only as many as the block cap allows: a
  // server is free to summarise in one and name the argument in the next.
  it("finds the named argument in the last block the cap reaches", async () => {
    const outcome = await failing({
      isError: true,
      content: [
        ...Array.from({ length: 7 }, () => ({
          type: "text",
          text: "The call could not be completed.",
        })),
        { type: "text", text: REFUSES_THE_ARGUMENTS },
      ],
    });

    expect(outcome.code).toBe(MCP_INPUT_REJECTED);
  });

  it("reads no further than the block cap for a named argument", async () => {
    const outcome = await failing({
      isError: true,
      content: [
        ...Array.from({ length: 8 }, () => ({
          type: "text",
          text: "The call could not be completed.",
        })),
        { type: "text", text: REFUSES_THE_ARGUMENTS },
      ],
    });

    expect(outcome.code).toBe("MCP_TOOL_ERROR");
  });

  it("reads past a block whose text is not a string", async () => {
    const outcome = await failing({
      isError: true,
      content: [
        { type: "text", text: 7 },
        { type: "text", text: REFUSES_THE_ARGUMENTS },
      ],
    });

    expect(outcome.code).toBe(MCP_INPUT_REJECTED);
  });
});

describe("which refusal of a revision this client may read past", () => {
  interface Handshake {
    code: string;
    retryable: unknown;
    offered: string[];
  }

  /** Refuses the first handshake and agrees to whatever the second one offers. */
  const handshaking = async (
    status: number,
    error: unknown,
  ): Promise<Handshake> => {
    const offered: string[] = [];
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        offered.push(String(body.params?.protocolVersion));
        return offered.length === 1
          ? jsonRpcResponse({ jsonrpc: "2.0", id: body.id, error }, status)
          : jsonRpcResponse({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: body.params?.protocolVersion,
                capabilities: { tools: {} },
              },
            });
      }
      return toolResult({ structuredContent: { ok: true } }, body.id);
    });

    try {
      await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      return { code: "read", retryable: "absent", offered };
    } catch (caught) {
      return {
        code:
          caught instanceof Error && "code" in caught
            ? String((caught as { code?: unknown }).code)
            : "none",
        retryable:
          caught instanceof Error && "retryable" in caught
            ? (caught as { retryable?: unknown }).retryable
            : "absent",
        offered,
      };
    }
  };

  const refusedTheVersion = (
    supported: unknown,
  ): { code: number; message: string; data?: unknown } => ({
    code: -32000,
    message: "Bad Request: Unsupported protocol version: 2025-06-18",
    ...(supported === undefined ? {} : { data: { supported } }),
  });

  it("offers a revision a refusal listed in its data", async () => {
    const outcome = await handshaking(400, refusedTheVersion(["2025-11-25"]));

    expect(outcome.code).toBe("read");
    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION, "2025-11-25"]);
  });

  it("reads the revisions out of the message when the data names none", async () => {
    const outcome = await handshaking(400, {
      code: -32000,
      message:
        "Bad Request: Unsupported protocol version: 2025-06-18 (supported versions: 2025-11-25)",
    });

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION, "2025-11-25"]);
  });

  it("reads the message when the data's list is not a list", async () => {
    const outcome = await handshaking(400, {
      code: -32000,
      message:
        "Bad Request: Unsupported protocol version: 2025-06-18 (supported versions: 2025-11-25)",
      data: { supported: "2025-11-25" },
    });

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION, "2025-11-25"]);
  });

  it("offers the one speakable revision among values that are not strings", async () => {
    const outcome = await handshaking(
      400,
      refusedTheVersion([1, null, { version: "2025-11-25" }, "2025-11-25"]),
    );

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION, "2025-11-25"]);
  });

  // Only a refusal that says it is about the revision may drive a second attempt. A 5xx has not
  // settled anything, so reading past it would turn a transient failure into a protocol verdict.
  it("does not read past a server error that happens to name revisions", async () => {
    const outcome = await handshaking(500, refusedTheVersion(["2025-11-25"]));

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION]);
    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
    expect(outcome.retryable).toBe(true);
  });

  it("does not read past a refusal that is about something else", async () => {
    const outcome = await handshaking(400, {
      code: -32600,
      message: "Bad Request: the accept header must allow text/event-stream",
      data: { supported: ["2025-11-25"] },
    });

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION]);
    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
  });

  // The refusal names the revision it rejected as well, and offering it again would loop.
  it("does not offer again the revision the refusal rejected", async () => {
    const outcome = await handshaking(
      400,
      refusedTheVersion([MCP_PROTOCOL_VERSION]),
    );

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION]);
    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
  });

  // Everything in a refusal is the server's own text, so only a revision-shaped value is read out
  // of one. A value that merely contains a date is not a revision this may offer.
  it("reads no revision out of a value that only contains one", async () => {
    const outcome = await handshaking(
      400,
      refusedTheVersion(["v2025-11-25", "2025-11-25-beta"]),
    );

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION]);
    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
  });

  // Every field of a refusal is the server's own, including the type of its message. A value that
  // is not text is not a statement about the revision, whatever it looks like once coerced.
  it("reads no revision out of a refusal whose message is not text", async () => {
    const outcome = await handshaking(400, {
      code: -32000,
      message: ["Bad Request: Unsupported protocol version: 2025-06-18"],
      data: { supported: ["2025-11-25"] },
    });

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION]);
    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
  });

  it("refuses a revision that is shaped like one but is not spoken here", async () => {
    const outcome = await handshaking(400, refusedTheVersion(["2024-01-01"]));

    expect(outcome.offered).toEqual([MCP_PROTOCOL_VERSION]);
    expect(outcome.code).toBe("MCP_VERSION_UNSUPPORTED");
    expect(outcome.retryable).toBe(false);
  });
});

describe("the session this client speaks under", () => {
  interface Seen {
    method: string;
    session: string | null;
    version: string | null;
  }

  const speaking = async (options: {
    minted?: string;
    notFound?: "once" | "always";
  }): Promise<{ code: string; seen: Seen[] }> => {
    const seen: Seen[] = [];
    let refusals = 0;
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      const headers = new Headers(init?.headers);
      seen.push({
        method: body.method,
        session: headers.get("mcp-session-id"),
        version: headers.get("mcp-protocol-version"),
      });
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...(options.minted === undefined
                ? {}
                : { "Mcp-Session-Id": options.minted }),
            },
          },
        );
      }
      const refuse =
        options.notFound === "always" ||
        (options.notFound === "once" && refusals === 0);
      if (refuse) {
        refusals += 1;
        return jsonRpcResponse(
          {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32000, message: "Session not found" },
          },
          404,
        );
      }
      return toolResult({ structuredContent: { ok: true } }, body.id);
    });

    try {
      await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      return { code: "read", seen };
    } catch (error) {
      return {
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "none",
        seen,
      };
    }
  };

  const sessionsOn = (seen: Seen[], method: string): (string | null)[] =>
    seen.filter((request) => request.method === method).map((r) => r.session);

  // A server that mints none is stateless, and an empty header is no more a session than a missing
  // one. Sending it back would name a session the server never opened.
  it.each([
    ["mints no session header", undefined],
    ["mints an empty session header", ""],
  ])("sends no session at all to a server that %s", async (_case, minted) => {
    const { seen } = await speaking({ minted });

    expect(sessionsOn(seen, "notifications/initialized")).toEqual([null]);
    expect(sessionsOn(seen, "tools/call")).toEqual([null]);
  });

  it("names the minted session on every request after the handshake", async () => {
    const { seen } = await speaking({ minted: "session-1" });

    expect(sessionsOn(seen, "initialize")).toEqual([null]);
    expect(sessionsOn(seen, "notifications/initialized")).toEqual(["session-1"]);
    expect(sessionsOn(seen, "tools/call")).toEqual(["session-1"]);
  });

  // A 404 from a stateless server is not a dropped session, so there is nothing to reopen and the
  // read is not repeated.
  it("does not reopen a session it never had", async () => {
    const { code, seen } = await speaking({ notFound: "always" });

    expect(code).toBe("MCP_TOOL_CALL_FAILED");
    expect(sessionsOn(seen, "tools/call")).toHaveLength(1);
    expect(sessionsOn(seen, "initialize")).toHaveLength(1);
  });

  // One repeat, not a loop: a server answering 404 under a session it just minted is refusing,
  // and asking again forever would keep a workflow reading a session that will never exist.
  it("repeats a read the server 404s exactly once", async () => {
    const { code, seen } = await speaking({
      minted: "session-1",
      notFound: "always",
    });

    expect(code).toBe("MCP_TOOL_CALL_FAILED");
    expect(sessionsOn(seen, "tools/call")).toHaveLength(2);
    expect(sessionsOn(seen, "initialize")).toHaveLength(2);
  });

  it("reads under the reopened session when the first one was dropped", async () => {
    const { code, seen } = await speaking({
      minted: "session-1",
      notFound: "once",
    });

    expect(code).toBe("read");
    expect(sessionsOn(seen, "tools/call")).toEqual(["session-1", "session-1"]);
  });
});

describe("what a discovery reads from a tool listing", () => {
  interface Listing {
    /** Tools per page; the walk reads one page per request. */
    pages?: unknown[][];
    /** The cursor each page names, position by position. Undefined ends the walk. */
    cursors?: unknown[];
    endless?: boolean;
    refuse?: unknown;
    result?: unknown;
  }

  interface Discovered {
    code: string;
    detail: string;
    message: string;
    names: unknown[];
    tools: McpToolDescriptor[];
    requests: number;
    /** The cursor each request carried, in order. */
    asked: unknown[];
  }

  const discovering = async (
    listing: Listing,
    headers?: Record<string, string>,
  ): Promise<Discovered> => {
    let listed = 0;
    const asked: unknown[] = [];
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        });
      }
      listed += 1;
      asked.push(
        (body as unknown as { params?: { cursor?: unknown } }).params?.cursor,
      );
      if (listing.refuse !== undefined) {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: body.id,
          error: listing.refuse,
        });
      }
      if (listing.result !== undefined) {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: listing.result,
        });
      }
      const pages = listing.pages ?? [[{ name: "run_sql" }]];
      const index = listed - 1;
      const page = pages[Math.min(index, pages.length - 1)] ?? [];
      const cursor =
        listing.endless === true
          ? `page-${String(listed)}`
          : listing.cursors === undefined
            ? index + 1 < pages.length
              ? `page-${String(listed)}`
              : undefined
            : listing.cursors[index];
      return jsonRpcResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: page,
          ...(cursor === undefined ? {} : { nextCursor: cursor }),
        },
      });
    });

    try {
      const tools = await createMcpDiscoveryFromEnv({
        fetch,
        resolveHost: async () => ["93.184.216.34"],
      })({ url: SERVER, ...(headers === undefined ? {} : { headers }) });
      return {
        code: "listed",
        detail: "",
        message: "listed",
        names: tools.map((tool) => tool.name),
        tools,
        requests: listed,
        asked,
      };
    } catch (error) {
      const seen = error as { code?: unknown; detail?: unknown };
      return {
        code: String(seen.code),
        detail: seen.detail === undefined ? "absent" : String(seen.detail),
        message: error instanceof Error ? error.message : "unknown",
        names: [],
        tools: [],
        requests: listed,
        asked,
      };
    }
  };

  it("reads every page until a server names no further cursor", async () => {
    const outcome = await discovering({
      pages: [[{ name: "a" }], [{ name: "b" }], [{ name: "c" }]],
    });

    expect(outcome.names).toEqual(["a", "b", "c"]);
    // Each request carries the cursor the page before it named. Asking without one would read the
    // first page again, however many times the bound allowed.
    expect(outcome.asked).toEqual([undefined, "page-1", "page-2"]);
  });

  it.each([
    ["names an empty cursor", ""],
    ["names a cursor that is not a string", 7],
    ["names a cursor that is null", null],
  ])("stops walking when a page %s", async (_case, cursor) => {
    const outcome = await discovering({
      pages: [[{ name: "a" }], [{ name: "b" }]],
      cursors: [cursor],
    });

    expect(outcome.names).toEqual(["a"]);
    expect(outcome.requests).toBe(1);
  });

  // The walk is bounded because a server naming a cursor forever would hold a run open for as
  // long as it liked. The bound is high enough that no real catalogue ends before it.
  it("reads no more pages than the walk allows", async () => {
    const outcome = await discovering({ endless: true });

    expect(outcome.requests).toBe(20);
    expect(outcome.names).toHaveLength(20);
  });

  it.each([
    ["a listing result that names no tools", {}],
    ["a listing whose tools are not a list", { tools: "run_sql" }],
    ["a listing result that is not an object", "run_sql"],
  ])("refuses %s", async (_case, result) => {
    expect(await discovering({ result })).toMatchObject({
      code: "MCP_INVALID_RESPONSE",
    });
  });

  it("reports what a server said when it refused to list its tools", async () => {
    const outcome = await discovering({
      refuse: { code: -32000, message: "this token may not list tools" },
    });

    expect(outcome.code).toBe("MCP_TOOL_LIST_REFUSED");
    expect(outcome.detail).toContain("may not list tools");
  });

  it("carries no detail when a listing was refused without a word", async () => {
    const outcome = await discovering({ refuse: { code: -32000 } });

    expect(outcome.code).toBe("MCP_TOOL_LIST_REFUSED");
    expect(outcome.detail).toBe("absent");
    expect(outcome.message).not.toContain("undefined");
  });

  // The refusal is the server's own text, and a server that echoes the credential it was given
  // would otherwise carry it back into a run record.
  it("reports no credential a listing presented back in its refusal", async () => {
    const outcome = await discovering(
      {
        refuse: {
          code: -32000,
          message: 'token "author-token" may not list the tools of this workspace',
        },
      },
      { Authorization: "Bearer author-token" },
    );

    expect(outcome.code).toBe("MCP_TOOL_LIST_REFUSED");
    expect(outcome.detail).not.toContain("author-token");
    expect(outcome.detail).toContain("may not list the tools");
  });

  it("reads past an entry a server listed that is not a named tool", async () => {
    const outcome = await discovering({
      pages: [[null, "run_sql", { name: 7 }, [], { name: "run_sql" }]],
    });

    expect(outcome.names).toEqual(["run_sql"]);
  });

  it("carries the description a server gave a tool", async () => {
    const outcome = await discovering({
      pages: [[{ name: "run_sql", description: "runs a query" }]],
    });

    expect(outcome.tools).toStrictEqual([
      {
        name: "run_sql",
        description: "runs a query",
        props: [],
        propsUnreadable: true,
        declaresOutputSchema: false,
      },
    ]);
  });

  it.each([
    ["left empty", ""],
    ["written as something other than text", { text: "runs a query" }],
  ])("carries no description for one a server %s", async (_case, description) => {
    const outcome = await discovering({
      pages: [[{ name: "run_sql", description }]],
    });

    expect(outcome.tools).toStrictEqual([
      {
        name: "run_sql",
        props: [],
        propsUnreadable: true,
        declaresOutputSchema: false,
      },
    ]);
  });

  // A tool declaring no output schema never populates structuredContent, so a workflow reading it
  // there would read nothing at all.
  it.each([
    ["declares an output schema", { type: "object" }, true],
    ["declares one that is not a schema", "object", false],
    ["declares none", undefined, false],
  ])("says a tool that %s", async (_case, outputSchema, declares) => {
    const outcome = await discovering({
      pages: [
        [
          {
            name: "run_sql",
            ...(outputSchema === undefined ? {} : { outputSchema }),
          },
        ],
      ],
    });

    expect(outcome.tools[0]?.declaresOutputSchema).toBe(declares);
  });

  it("says a tool takes only what it names when its schema is closed", async () => {
    const outcome = await discovering({
      pages: [
        [
          {
            name: "run_sql",
            inputSchema: {
              type: "object",
              properties: { sql: { type: "string" } },
              additionalProperties: false,
            },
          },
        ],
      ],
    });

    expect(outcome.tools).toStrictEqual([
      {
        name: "run_sql",
        props: [{ name: "sql", type: "string", required: false }],
        declaresOutputSchema: false,
      },
    ]);
  });

  // Nothing bounds a schema but additionalProperties: false, so anything else takes more than it
  // names and an argument it does not list cannot be called one it refuses.
  it("says a tool takes more than it names when its schema is open", async () => {
    const outcome = await discovering({
      pages: [
        [
          {
            name: "run_sql",
            inputSchema: {
              type: "object",
              properties: { sql: { type: "string" } },
              additionalProperties: true,
            },
          },
        ],
      ],
    });

    expect(outcome.tools).toStrictEqual([
      {
        name: "run_sql",
        props: [{ name: "sql", type: "string", required: false }],
        acceptsExtraProps: true,
        declaresOutputSchema: false,
      },
    ]);
  });

  it("says nothing about the arguments of a tool that declares no schema", async () => {
    const outcome = await discovering({ pages: [[{ name: "run_sql" }]] });

    expect(outcome.tools[0]).toMatchObject({ props: [], propsUnreadable: true });
    expect(outcome.tools[0]).not.toHaveProperty("acceptsExtraProps");
  });

  it.each(["anyOf", "oneOf"])(
    "does not read the arguments of a schema deferred behind %s",
    async (keyword) => {
      const outcome = await discovering({
        pages: [
          [
            {
              name: "run_sql",
              inputSchema: {
                [keyword]: [{ type: "object", properties: { sql: {} } }],
              },
            },
          ],
        ],
      });

      expect(outcome.tools[0]).toMatchObject({ propsUnreadable: true });
    },
  );

  it("reads a property whose declaration names no type as unknown", async () => {
    const outcome = await discovering({
      pages: [
        [
          {
            name: "run_sql",
            inputSchema: {
              type: "object",
              properties: { sql: { description: "a query" }, limit: 10 },
            },
          },
        ],
      ],
    });

    expect(outcome.tools[0]?.props).toEqual([
      { name: "sql", type: "unknown", required: false },
      { name: "limit", type: "unknown", required: false },
    ]);
  });

  it.each([
    ["is not a list", "sql"],
    ["holds values that are not names", [7, null]],
  ])("requires nothing when a schema's required %s", async (_case, required) => {
    const outcome = await discovering({
      pages: [
        [
          {
            name: "run_sql",
            inputSchema: {
              type: "object",
              properties: { sql: { type: "string" } },
              required,
            },
          },
        ],
      ],
    });

    expect(outcome.tools[0]?.props).toEqual([
      { name: "sql", type: "string", required: false },
    ]);
  });

  it("requires the names a schema lists among values that are not names", async () => {
    const outcome = await discovering({
      pages: [
        [
          {
            name: "run_sql",
            inputSchema: {
              type: "object",
              properties: { sql: { type: "string" } },
              required: [7, "sql"],
            },
          },
        ],
      ],
    });

    expect(outcome.tools[0]?.props).toEqual([
      { name: "sql", type: "string", required: true },
    ]);
  });
});

describe("a discovery refuses an address before it opens a session", () => {
  const refusalFor = async (
    input: unknown,
  ): Promise<{ code: string; message: string; calls: number }> => {
    const fetch = vi.fn<FetchLike>();
    try {
      await createMcpDiscoveryFromEnv({
        fetch,
        resolveHost: async () => ["93.184.216.34"],
      })(input as McpDiscoveryInput);
      return { code: "listed", message: "listed", calls: fetch.mock.calls.length };
    } catch (error) {
      return {
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "none",
        message: error instanceof Error ? error.message : "unknown",
        calls: fetch.mock.calls.length,
      };
    }
  };

  it.each([
    ["no url at all", {}, URL_MISSING],
    ["a url that is not a string", { url: 3 }, URL_MISSING],
    ["a url that is only whitespace", { url: "  " }, URL_MISSING],
    [
      "a url that is not an address",
      { url: "mcp.example.com/mcp" },
      "url is not a usable address",
    ],
  ])("says what is wrong and lists nothing for %s", async (_case, input, clause) => {
    const outcome = await refusalFor(input);

    expect(outcome.code).toBe("INVALID_MCP_REQUEST");
    expect(outcome.message).toContain(clause);
    expect(outcome.calls).toBe(0);
  });

  it("refuses an address the egress guard blocks", async () => {
    const outcome = await refusalFor({ url: "http://169.254.169.254/mcp" });

    expect(outcome.code).toBe("HTTP_EGRESS_BLOCKED");
    expect(outcome.calls).toBe(0);
  });
});

describe("the guard every mcp request goes through", () => {
  // Wide enough that a loaded machine still completes a lifecycle inside it, and far short of the
  // stall the doubles answer with, so what the deadline bounds is never in doubt.
  const DEADLINE_MS = 250;
  const STALL_MS = 2_000;

  const answering = (): ReturnType<typeof answersWith> =>
    answersWith((id) => toolResult({ structuredContent: { ok: true } }, id));

  /** Answers late, and only if the deadline the guard hands it has not already passed. */
  const slow = (): ReturnType<typeof vi.fn<FetchLike>> =>
    vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, STALL_MS);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

  /** Completes the lifecycle at once, then stalls the request the call was made for. */
  const stallingAfterHandshake = (): ReturnType<typeof vi.fn<FetchLike>> =>
    vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        });
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, STALL_MS);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
      return toolResult({ tools: [], structuredContent: { ok: true } }, body.id);
    });

  const codeOf = (error: unknown): string =>
    error instanceof Error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "none";

  const callFailing = async (
    options: Omit<McpIntegrationOptions, "fetch"> & { fetch: FetchLike },
  ): Promise<string> => {
    try {
      await createMcpIntegrationFromEnv(options).read({
        url: SERVER,
        toolName: "ping",
      });
      return "read";
    } catch (error) {
      return codeOf(error);
    }
  };

  const listFailing = async (
    options: Omit<McpIntegrationOptions, "fetch"> & { fetch: FetchLike },
  ): Promise<string> => {
    try {
      await createMcpDiscoveryFromEnv(options)({ url: SERVER });
      return "listed";
    } catch (error) {
      return codeOf(error);
    }
  };

  // Without the resolver the guard never learns what the name stands for, so it checks the name
  // and lets the address through. The lookup is the check.
  it("asks the resolver it was given about the server's name", async () => {
    const resolveHost = vi.fn(async () => ["93.184.216.34"]);

    await createMcpIntegrationFromEnv({ fetch: answering(), resolveHost }).read({
      url: SERVER,
      toolName: "ping",
    });

    expect(resolveHost).toHaveBeenCalledWith("mcp.example.com");
  });

  it("asks the resolver it was given about a listing's server name", async () => {
    const resolveHost = vi.fn(async () => ["93.184.216.34"]);
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        });
      }
      return toolResult({ tools: [] }, body.id);
    });

    await createMcpDiscoveryFromEnv({ fetch, resolveHost })({ url: SERVER });

    expect(resolveHost).toHaveBeenCalledWith("mcp.example.com");
  });

  it("refuses a tool call to a name that resolves inside the network", async () => {
    const fetch = answering();

    expect(
      await callFailing({ fetch, resolveHost: async () => ["127.0.0.1"] }),
    ).toBe("HTTP_EGRESS_BLOCKED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a listing of a name that resolves inside the network", async () => {
    const fetch = answering();

    expect(
      await listFailing({ fetch, resolveHost: async () => ["127.0.0.1"] }),
    ).toBe("HTTP_EGRESS_BLOCKED");
    expect(fetch).not.toHaveBeenCalled();
  });

  // The handshake may be sent over a fetch the caller does not observe, and it is guarded exactly
  // as the other one is: a blocked address never reaches either.
  it("refuses a handshake over the probe fetch to a blocked address", async () => {
    const probeFetch = answering();
    const fetch = answering();

    expect(
      await callFailing({
        fetch,
        probeFetch,
        resolveHost: async () => ["127.0.0.1"],
      }),
    ).toBe("HTTP_EGRESS_BLOCKED");
    expect(probeFetch).not.toHaveBeenCalled();
  });

  it("handshakes over the only fetch it was given", async () => {
    const fetch = answering();

    await createMcpIntegrationFromEnv({
      fetch,
      resolveHost: async () => ["93.184.216.34"],
    }).read({ url: SERVER, toolName: "ping" });

    expect(
      fetch.mock.calls.map(([, init]) => methodOf(init)),
    ).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it.each([
    ["a tool call", callFailing],
    ["a listing", listFailing],
  ])("refuses %s under a signal that is already aborted", async (_case, run) => {
    const fetch = answering();

    expect(
      await run({
        fetch,
        resolveHost: async () => ["93.184.216.34"],
        signal: AbortSignal.abort(),
      }),
    ).toBe("MCP_INITIALIZE_FAILED");
    expect(fetch).not.toHaveBeenCalled();
  });

  // Both ports die in the handshake here, which is one behaviour however many ways it is reached.
  it("bounds a handshake a server leaves unanswered", async () => {
    expect(
      await callFailing({
        fetch: slow(),
        resolveHost: async () => ["93.184.216.34"],
        timeoutMs: DEADLINE_MS,
      }),
    ).toBe("MCP_INITIALIZE_FAILED");
  });

  // The deadline is the whole invocation's, not the handshake's: a server free to answer the
  // handshake at once and then stall would otherwise hold a run open past its bound.
  it("bounds a tool call a server answers the handshake for and then stalls", async () => {
    expect(
      await callFailing({
        fetch: stallingAfterHandshake(),
        resolveHost: async () => ["93.184.216.34"],
        timeoutMs: DEADLINE_MS,
      }),
    ).toBe("MCP_TOOL_CALL_FAILED");
  });

  it("bounds a listing a server answers the handshake for and then stalls", async () => {
    expect(
      await listFailing({
        fetch: stallingAfterHandshake(),
        resolveHost: async () => ["93.184.216.34"],
        timeoutMs: DEADLINE_MS,
      }),
    ).toBe("MCP_TOOL_LIST_FAILED");
  });
});

describe("how an answered tool call is classified", () => {
  const answered = async (
    result: unknown,
  ): Promise<{ code: string; detail: unknown }> => {
    const fetch = answersWith((id) => toolResult(result, id));
    try {
      await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      return { code: "read", detail: "absent" };
    } catch (error) {
      const seen = error as { code?: unknown; detail?: unknown };
      return {
        code: String(seen.code),
        detail: seen.detail === undefined ? "absent" : String(seen.detail),
      };
    }
  };

  const refused = async (
    error: unknown,
  ): Promise<{ code: string; detail: unknown }> => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({ jsonrpc: "2.0", id, error }),
    );
    try {
      await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      return { code: "read", detail: "absent" };
    } catch (caught) {
      const seen = caught as { code?: unknown; detail?: unknown };
      return {
        code: String(seen.code),
        detail: seen.detail === undefined ? "absent" : String(seen.detail),
      };
    }
  };

  it.each([
    ["a result that is not an object", "done"],
    ["a result that is a list", [{ ok: true }]],
    ["a result that is null", null],
  ])("refuses %s", async (_case, result) => {
    expect(await answered(result)).toMatchObject({
      code: "MCP_INVALID_RESPONSE",
    });
  });

  it("accepts a result that carries only structured output", async () => {
    expect(await answered({ structuredContent: { rows: 1 } })).toMatchObject({
      code: "read",
    });
  });

  // JSON-RPC's own code for arguments it would not accept. Nothing ran, which is the one thing a
  // workflow needs to know before it is asked to try again.
  it("reads an invalid-params frame as a refusal of the arguments", async () => {
    expect(
      await refused({ code: -32602, message: "Invalid arguments" }),
    ).toMatchObject({ code: MCP_INPUT_REJECTED });
  });

  it("reads any other refusal frame as a refused call", async () => {
    expect(
      await refused({ code: -32000, message: "the query timed out" }),
    ).toMatchObject({
      code: "MCP_TOOL_CALL_REFUSED",
      detail: expect.stringContaining("the query timed out"),
    });
  });

  it("carries no detail for a refusal frame that said nothing", async () => {
    const fetch = answersWith((id) =>
      jsonRpcResponse({ jsonrpc: "2.0", id, error: { code: -32000 } }),
    );
    const caught = await context(fetch)
      .mcp.read({ url: SERVER, toolName: "ping" })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "MCP_TOOL_CALL_REFUSED" });
    // Nothing to report is reported as nothing, never as the word undefined.
    expect((caught as Error).message).not.toContain("undefined");
  });

  // The reference server formats the same code into an isError result's text, so the text is read
  // for it as well: the same refusal must not classify two ways depending on how it was framed.
  it("reads the same code reported through a result as a refusal of the arguments", async () => {
    expect(
      await answered({
        isError: true,
        content: [{ type: "text", text: "MCP error -32602: Invalid arguments" }],
      }),
    ).toMatchObject({ code: MCP_INPUT_REJECTED });
  });

  it("reads a reported failure that names no code as the tool's own error", async () => {
    expect(
      await answered({
        isError: true,
        content: [{ type: "text", text: "the query timed out" }],
      }),
    ).toMatchObject({
      code: "MCP_TOOL_ERROR",
      detail: expect.stringContaining("the query timed out"),
    });
  });

  it("reports an error flag raised with no content at all", async () => {
    const fetch = answersWith((id) =>
      toolResult({ isError: true, content: [] }, id),
    );
    const caught = await context(fetch)
      .mcp.read({ url: SERVER, toolName: "ping" })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ code: "MCP_TOOL_ERROR" });
    expect((caught as Error).message).not.toContain("undefined");
  });

  it("reads an error flag that is false as a result", async () => {
    expect(
      await answered({ isError: false, structuredContent: { rows: 1 } }),
    ).toMatchObject({ code: "read" });
  });
});

describe("what a handshake a server answered but refused reports", () => {
  const handshakeRefused = async (
    error: unknown,
    headers?: Record<string, string>,
  ): Promise<{
    code: string;
    detail: unknown;
    message: string;
    dispatched: boolean;
  }> => {
    let dispatched = false;
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        // 200 with an error frame: the transport succeeded, so the refusal is the frame's.
        return jsonRpcResponse({ jsonrpc: "2.0", id: body.id, error });
      }
      dispatched = true;
      return toolResult({ structuredContent: { ok: true } }, body.id);
    });

    try {
      await context(fetch).mcp.read({
        url: SERVER,
        toolName: "ping",
        ...(headers === undefined ? {} : { headers }),
      });
      return { code: "read", detail: "absent", message: "read", dispatched };
    } catch (caught) {
      const seen = caught as { code?: unknown; detail?: unknown };
      return {
        code: String(seen.code),
        detail: seen.detail === undefined ? "absent" : String(seen.detail),
        message: caught instanceof Error ? caught.message : "unknown",
        dispatched,
      };
    }
  };

  it("reports what the server said and calls no tool", async () => {
    const outcome = await handshakeRefused({
      code: -32000,
      message: "this workspace is suspended",
    });

    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
    expect(outcome.detail).toContain("this workspace is suspended");
    expect(outcome.dispatched).toBe(false);
  });

  it("carries no detail when the refusal said nothing", async () => {
    const outcome = await handshakeRefused({ code: -32000 });

    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
    expect(outcome.detail).toBe("absent");
    expect(outcome.message).not.toContain("undefined");
  });

  it("reports no credential the handshake presented back in its refusal", async () => {
    const outcome = await handshakeRefused(
      { code: -32000, message: 'token "author-token" is not for this workspace' },
      { Authorization: "Bearer author-token" },
    );

    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
    expect(outcome.detail).not.toContain("author-token");
    expect(outcome.detail).toContain("is not for this workspace");
  });
});

describe("which request names the tool being called", () => {
  const headerOn = (
    fetch: ReturnType<typeof answersWith>,
    method: string,
    header: string,
  ): string | null =>
    new Headers(requestTo(fetch, method)?.headers).get(header);

  // The lifecycle requests call no tool, and naming one on them would tell a server this client
  // is calling something it is not.
  it("names the tool on the request that calls it and on no other", async () => {
    const fetch = answersWith((id) =>
      toolResult({ structuredContent: { ok: true } }, id),
    );

    await context(fetch).mcp.read({ url: SERVER, toolName: "run_sql" });

    expect(headerOn(fetch, "tools/call", "mcp-name")).toBe("run_sql");
    expect(headerOn(fetch, "initialize", "mcp-name")).toBeNull();
    expect(headerOn(fetch, "notifications/initialized", "mcp-name")).toBeNull();
  });
});

describe("a handshake refused for authorization", () => {
  /** Answers the handshake with a status and a body that is not a JSON-RPC frame. */
  const handshakeAnswering = async (
    status: number,
    listing: boolean,
  ): Promise<string> => {
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (body.method === "initialize") {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return toolResult({ structuredContent: { ok: true } }, body.id);
    });

    try {
      if (listing) {
        await createMcpDiscoveryFromEnv({
          fetch,
          resolveHost: async () => ["93.184.216.34"],
        })({ url: SERVER });
      } else {
        await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      }
      return "went ahead";
    } catch (error) {
      return error instanceof Error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "none";
    }
  };

  // Only a listing reads an authorization status as its own answer, because only a listing can
  // report "this needs a credential" as the result. A tool call keeps the transport's verdict.
  it.each([401, 403])(
    "tells a listing that %s is what a credential would have fixed",
    async (status) => {
      expect(await handshakeAnswering(status, true)).toBe(
        MCP_TOOL_LIST_UNAUTHORIZED,
      );
    },
  );

  it.each([401, 403])(
    "leaves a tool call's %s handshake classified by the transport",
    async (status) => {
      expect(await handshakeAnswering(status, false)).toBe(
        "MCP_INITIALIZE_FAILED",
      );
    },
  );
});

describe("the lifecycle a tool call is built on", () => {
  const lifecycle = async (options: {
    initializedStatus?: number;
  }): Promise<{ code: string; methods: string[] }> => {
    const methods: string[] = [];
    const fetch = vi.fn<FetchLike>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      methods.push(body.method);
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: options.initializedStatus ?? 202 });
      }
      if (body.method === "initialize") {
        return jsonRpcResponse({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
          },
        });
      }
      return toolResult({ structuredContent: { ok: true } }, body.id);
    });

    try {
      await context(fetch).mcp.read({ url: SERVER, toolName: "ping" });
      return { code: "read", methods };
    } catch (error) {
      return {
        code:
          error instanceof Error && "code" in error
            ? String((error as { code?: unknown }).code)
            : "none",
        methods,
      };
    }
  };

  // The revision requires the client to say it is initialized, and the transport answers an
  // accepted notification with 202. A server that refuses it has not completed a lifecycle this
  // may build a call on.
  it("calls no tool when the server rejects the initialized notification", async () => {
    const outcome = await lifecycle({ initializedStatus: 400 });

    expect(outcome.code).toBe("MCP_INITIALIZE_FAILED");
    expect(outcome.methods).toEqual(["initialize", "notifications/initialized"]);
  });

  it("says it is initialized before it calls a tool", async () => {
    const outcome = await lifecycle({});

    expect(outcome.code).toBe("read");
    expect(outcome.methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
  });
});

describe("the headers this client owns whatever an author sent", () => {
  // The transport refuses a request whose header and body name different revisions, so an author
  // header winning here would break every call this client makes.
  it.each([
    ["content-type", "text/plain", "application/json"],
    ["accept", "text/plain", "application/json, text/event-stream"],
    ["mcp-protocol-version", "1999-01-01", MCP_PROTOCOL_VERSION],
    ["mcp-method", "tools/list", "tools/call"],
  ])("sends its own %s", async (name, sent, expected) => {
    const fetch = answersWith((id) =>
      toolResult({ structuredContent: { ok: true } }, id),
    );

    await context(fetch).mcp.read({
      url: SERVER,
      toolName: "ping",
      headers: { [name]: sent },
    });

    expect(new Headers(requestTo(fetch, "tools/call")?.headers).get(name)).toBe(
      expected,
    );
  });
});

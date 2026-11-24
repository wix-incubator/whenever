import {
  type McpIntegration,
  type McpToolCallInput,
  type McpToolResult,
  NonRetryableError,
} from "@wix/whenever-workflow-sdk";

import {
  assertAllowedEgressUrl,
  createGuardedFetch,
  type ResolveHost,
} from "./egress";
import {
  describedByteLimit,
  type FetchLike,
  HTTP_REQUEST_BODY_LIMIT_BYTES,
  HTTP_RESPONSE_BODY_LIMIT_BYTES,
  type HttpEnvelope,
  presentedRequestValues,
  requestEnvelope,
  withoutPresentedValues,
} from "./http";
import {
  discoveryUrl,
  initializeSession,
  invalidRequest,
  isPlainRecord,
  type JsonRpcEnvelope,
  MCP_CLIENT_NAME,
  MCP_PROTOCOL_VERSION,
  type McpLifecycle,
  nextRequestId,
  reportedText,
  requestHeaders,
  responseFrame,
  UNAUTHORIZED_STATUSES,
} from "./mcp-transport";
import {
  describeProviderInputRefusal,
  providerInputRefusalMessage,
} from "./provider-input-refusal";
import { strictJsonSnapshot, strictJsonViolation } from "./strict-json";

// A tool this never reaches reads as a tool the server does not have, so the walk is bounded high
// enough that no real catalogue ends before it.
const MAX_TOOL_LIST_PAGES = 20;

export interface McpIntegrationOptions {
  fetch: FetchLike;
  /**
   * Used for the lifecycle requests, which settle the revision and the session but cannot apply
   * anything. A caller that reads mutation evidence off the requests it observes supplies a fetch
   * it does not observe here, so a handshake never stands as evidence that a write took effect.
   * Guarded exactly as `fetch` is. Defaults to `fetch`.
   */
  probeFetch?: FetchLike;
  resolveHost?: ResolveHost;
  timeoutMs?: number;
  signal?: AbortSignal;
  connections?: Readonly<Record<string, McpConnection>>;
}

export interface McpConnection {
  /**
   * The resource URI the token was issued for (RFC 8707); a call must name it or a URL beneath it on
   * the same scheme, host and port, since RFC 9728 lets a root document name the origin.
   */
  readonly resource: string;
  readonly headers: Readonly<Record<string, string>>;
}

export const MCP_INPUT_REJECTED = "MCP_INPUT_REJECTED";

export const MCP_CONNECTION_REFUSED = "MCP_CONNECTION_REFUSED";

function connectionRefused(message: string): NonRetryableError {
  return new NonRetryableError(`MCP connection refused: ${message}.`, {
    code: MCP_CONNECTION_REFUSED,
  });
}

/** Returns the input carrying the named connection's headers, or the input unchanged without one. */
function connected(
  connections: McpIntegrationOptions["connections"],
  input: McpToolCallInput,
  url: URL,
): McpToolCallInput {
  const name = input.connection;
  if (name === undefined) return input;
  const connection =
    connections !== undefined && Object.prototype.hasOwnProperty.call(connections, name)
      ? connections[name]
      : undefined;
  if (connection === undefined) {
    throw connectionRefused(`connection "${name}" is not available here`);
  }
  if (!resourceCovers(connection.resource, url)) {
    throw connectionRefused(`connection "${name}" sends only to ${connection.resource}`);
  }
  if (Object.keys(input.headers ?? {}).some((header) => header.toLowerCase() === "authorization")) {
    throw connectionRefused(`connection "${name}" sets the authorization header itself`);
  }
  return { ...input, headers: { ...input.headers, ...connection.headers } };
}

// RFC 8707 resource identity, where query and fragment never name a different server, nor does one
// trailing slash; the path stays case-sensitive. A resource covers the whole segments beneath it:
// `/a` covers `/a/b`, never `/ab`.
function resourceCovers(resource: string, url: URL): boolean {
  const granted = new URL(resource);
  if (url.protocol !== "https:" || granted.protocol !== url.protocol || granted.host !== url.host) return false;
  const prefix = granted.pathname.replace(/\/$/u, "");
  const path = url.pathname.replace(/\/$/u, "");
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * A JSON-RPC error frame refusing the arguments, which a server sends instead of a result. The
 * evidence is the frame, never the wording: a late check reports through `isError` in the same words.
 */
export const MCP_ARGUMENTS_REFUSED = "MCP_ARGUMENTS_REFUSED";

export const MCP_TOOL_LIST_UNAUTHORIZED = "MCP_TOOL_LIST_UNAUTHORIZED";

/** Only these two establish that a credential was what the listing lacked. */
function unauthorizedListing(status: number): NonRetryableError {
  return new NonRetryableError(
    `MCP server refused to list its tools without authorization (${String(status)}).`,
    { code: MCP_TOOL_LIST_UNAUTHORIZED },
  );
}

// JSON-RPC "Invalid params", answered either as an error frame or — as the reference MCP server
// formats an McpError — inside an isError result's text. Both refuse the arguments.
const INVALID_PARAMS = -32602;
const INVALID_PARAMS_REPORTED = /\bMCP error -32602\b/u;

function validated(input: unknown): McpToolCallInput {
  if (!isPlainRecord(input)) throw invalidRequest("input must be an object");
  if (typeof input.url !== "string" || input.url.trim() === "") {
    throw invalidRequest("url must be a non-empty string");
  }
  if (typeof input.toolName !== "string" || input.toolName.trim() === "") {
    throw invalidRequest("toolName must be a non-empty string");
  }
  if (input.toolProps !== undefined && !isPlainRecord(input.toolProps)) {
    throw invalidRequest("toolProps must be an object");
  }
  if (
    input.connection !== undefined &&
    (typeof input.connection !== "string" || input.connection.trim() === "")
  ) {
    throw invalidRequest("connection must be a non-empty string");
  }
  if (input.headers !== undefined) {
    if (!isPlainRecord(input.headers)) {
      throw invalidRequest("headers must be an object of strings");
    }
    for (const [name, value] of Object.entries(input.headers)) {
      if (name.trim() === "" || typeof value !== "string") {
        throw invalidRequest(
          "headers must contain non-empty names and string values",
        );
      }
    }
  }
  return input as unknown as McpToolCallInput;
}

function targetUrl(input: McpToolCallInput): URL {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw invalidRequest(`url is not a usable address: ${input.url}`);
  }
  assertAllowedEgressUrl(url);
  return url;
}

function requestBody(
  input: McpToolCallInput,
  version: string = MCP_PROTOCOL_VERSION,
): { id: number; body: string } {
  const id = nextRequestId();
  const snapshot = strictJsonSnapshot(input.toolProps ?? {});
  if (snapshot === undefined) {
    const violation = strictJsonViolation(input.toolProps ?? {}, "toolProps");
    throw invalidRequest(
      violation === undefined
        ? "toolProps must be finite, acyclic strict JSON"
        : `toolProps must be finite, acyclic strict JSON: ${violation}`,
    );
  }
  const encoded = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: input.toolName,
      arguments: snapshot.value,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: MCP_CLIENT_NAME,
          version: MCP_PROTOCOL_VERSION,
        },
      },
    },
  });
  if (
    new TextEncoder().encode(encoded).byteLength > HTTP_REQUEST_BODY_LIMIT_BYTES
  ) {
    throw invalidRequest(
      `tool call exceeds ${describedByteLimit(HTTP_REQUEST_BODY_LIMIT_BYTES)}`,
    );
  }
  return { id, body: encoded };
}

/**
 * The server's own words outrank any schema this side holds. Masked before reading, so a refusal
 * echoing a presented credential cannot carry one back out as a name.
 */
function refusedArguments(
  call: McpToolCallInput,
  reported: string | undefined,
  presented: readonly string[],
  repair: string,
): string | undefined {
  if (reported === undefined) return undefined;
  const refusal = describeProviderInputRefusal(
    withoutPresentedValues(reported, presented),
    call.toolProps,
  );
  return refusal === undefined
    ? undefined
    : providerInputRefusalMessage(call.toolName, refusal, repair);
}

const SEND_WHAT_IT_ASKS_FOR =
  "Send the names the provider asks for; this call's names are in the workflow source.";
/** Only where the shape of the refusal establishes it, which is the error frame and nothing else. */
const NOTHING_RAN = `Nothing ran. ${SEND_WHAT_IT_ASKS_FOR}`;

function toolResult(
  envelope: JsonRpcEnvelope,
  call: McpToolCallInput,
  presented: readonly string[],
): McpToolResult {
  if (envelope.error !== undefined) {
    const invalidParams = envelope.error.code === INVALID_PARAMS;
    const refused = refusedArguments(
      call,
      reportedFrame(envelope.error),
      presented,
      invalidParams ? NOTHING_RAN : SEND_WHAT_IT_ASKS_FOR,
    );
    if (refused !== undefined) {
      throw new NonRetryableError(refused, {
        code: invalidParams ? MCP_ARGUMENTS_REFUSED : MCP_INPUT_REJECTED,
        detail: refused,
      });
    }
    const detail = reportedText(envelope.error.message, presented);
    throw new NonRetryableError(
      `MCP tool call was refused${detail === undefined ? "" : `: ${detail}`}.`,
      {
        code: invalidParams ? MCP_INPUT_REJECTED : "MCP_TOOL_CALL_REFUSED",
        ...(detail === undefined ? {} : { detail }),
      },
    );
  }
  const result = envelope.result;
  if (!isPlainRecord(result)) {
    throw new NonRetryableError("MCP server answered without a tool result.", {
      code: "MCP_INVALID_RESPONSE",
    });
  }
  // A flag that is present but not a boolean is refused rather than read as success: a failed write
  // reported as a succeeded one is the one outcome this must never produce.
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new NonRetryableError(
      "MCP server reported a tool result whose isError flag is not a boolean.",
      { code: "MCP_INVALID_RESPONSE" },
    );
  }
  if (result.isError === true) {
    const reported = firstText(result.content);
    const refused = refusedArguments(
      call,
      everyText(result.content),
      presented,
      SEND_WHAT_IT_ASKS_FOR,
    );
    // A result, so the tool ran as far as the server is concerned: the names are reported and the
    // code stays the one that leaves a write's doubt where the egress put it.
    if (refused !== undefined) {
      throw new NonRetryableError(refused, {
        code: MCP_INPUT_REJECTED,
        detail: refused,
      });
    }
    const detail = reportedText(reported, presented);
    throw new NonRetryableError(
      `MCP tool reported an error${detail === undefined ? "" : `: ${detail}`}.`,
      {
        code:
          reported !== undefined && INVALID_PARAMS_REPORTED.test(reported)
            ? MCP_INPUT_REJECTED
            : "MCP_TOOL_ERROR",
        ...(detail === undefined ? {} : { detail }),
      },
    );
  }
  // An answer carrying neither half is not a result the workflow can read, and returning it would
  // report an empty object as a succeeded call.
  if (!("content" in result) && !("structuredContent" in result)) {
    throw new NonRetryableError(
      "MCP server answered with a tool result carrying neither content nor structured output.",
      { code: "MCP_INVALID_RESPONSE" },
    );
  }
  return {
    structuredContent: result.structuredContent,
    content: result.content,
  };
}

const REPORTED_BLOCK_LIMIT = 8;

/**
 * Every text block rather than the first, because a server is free to summarise in one and report
 * the arguments in the next — measured on a server that answers both a reason and its HTTP echo.
 */
function everyText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content.slice(0, REPORTED_BLOCK_LIMIT)) {
    if (isPlainRecord(block) && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.length === 0 ? undefined : texts.join("\n");
}

/** `data` as well as `message`: JSON-RPC lets a server carry its validation issues in either. */
function reportedFrame(error: {
  message?: unknown;
  data?: unknown;
}): string | undefined {
  const parts: string[] = [];
  if (typeof error.message === "string" && error.message !== "") {
    parts.push(error.message);
  }
  if (error.data !== undefined) {
    // Parsed from a bounded response body, so it is acyclic and already size-limited.
    try {
      parts.push(JSON.stringify(error.data) ?? "");
    } catch {
      // A value JSON cannot describe carries no argument name either.
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isPlainRecord(block) && typeof block.text === "string") return block.text;
  }
  return undefined;
}

export function prepareMcpToolCallInput(input: unknown): {
  input: McpToolCallInput;
  url: URL;
  headers: Headers;
  id: number;
  body: string;
} {
  const validatedInput = validated(input);
  const { body, id } = requestBody(validatedInput);
  return {
    input: validatedInput,
    url: targetUrl(validatedInput),
    headers: requestHeaders(validatedInput, "tools/call", validatedInput.toolName),
    id,
    body,
  };
}

export function createMcpIntegrationFromEnv({
  fetch: rawFetch,
  probeFetch: rawProbeFetch,
  resolveHost,
  timeoutMs,
  signal,
  connections,
}: McpIntegrationOptions): McpIntegration {
  const guard = {
    ...(resolveHost !== undefined ? { resolveHost } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
  const guardedFetches = (redirects: boolean) => {
    const options = { ...guard, followRedirects: redirects };
    const fetch = createGuardedFetch(rawFetch, options);
    return {
      fetch,
      probeFetch:
        rawProbeFetch === undefined ? fetch : createGuardedFetch(rawProbeFetch, options),
    };
  };
  const unconnected = guardedFetches(true);
  // A redirect must not carry the connection's credentials to another server.
  const withConnection = guardedFetches(false);

  const call = async (
    failureMode: "safe" | "write",
    rawInput: unknown,
  ): Promise<McpToolResult> => {
    const prepared = prepareMcpToolCallInput(rawInput);
    const { url } = prepared;
    const input = connected(connections, prepared.input, url);
    const { fetch, probeFetch } =
      input === prepared.input ? unconnected : withConnection;
    const dispatch = async (
      lifecycle: McpLifecycle,
      mayReopenSession: boolean,
    ): Promise<{ envelope: HttpEnvelope; init: RequestInit; id: number }> => {
      // Built here rather than before the handshake: the transport requires the header and the
      // body to name the same revision, and only the handshake knows which one that is.
      const { body, id } = requestBody(input, lifecycle.protocolVersion);
      const init: RequestInit = {
        method: "POST",
        headers: requestHeaders(input, "tools/call", input.toolName, lifecycle),
        body,
      };
      const envelope = await requestEnvelope(fetch, url, {
        code: "MCP_TOOL_CALL_FAILED",
        failureMode,
        maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
        // A session the server has dropped is answered with 404 before the tool is reached, so
        // that body is read rather than thrown, and only for a read this may safely repeat.
        ...(mayReopenSession &&
        lifecycle.sessionId !== undefined &&
        failureMode === "safe"
          ? { acceptErrorResponse: (status: number) => status === 404 }
          : {}),
        init,
      });
      return { envelope, init, id };
    };

    let { envelope, init, id } = await dispatch(
      await initializeSession(probeFetch, url, input),
      true,
    );
    if (envelope.status === 404) {
      // The session is gone, so a new one is opened and the read repeated under it.
      ({ envelope, init, id } = await dispatch(
        await initializeSession(probeFetch, url, input),
        false,
      ));
    }
    return toolResult(
      responseFrame(envelope.body, id),
      input,
      presentedRequestValues(url, init),
    );
  };

  return {
    async read(input) {
      return call("safe", input);
    },
    async write(input) {
      return call("write", input);
    },
  };
}

export interface McpToolProp {
  name: string;
  type: string;
  required: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  props: McpToolProp[];
  /**
   * Set when the tool has an input schema this reader cannot follow, such as one behind `$ref` or
   * `allOf`. Its arguments are unknown rather than absent, so `props` proves nothing about them.
   */
  propsUnreadable?: true;
  /** Set unless the schema closes itself, because only `additionalProperties: false` bounds it. */
  acceptsExtraProps?: true;
  /**
   * A tool declaring none never populates `structuredContent`, so read its result from `content`.
   */
  declaresOutputSchema: boolean;
}

export interface McpDiscoveryInput {
  url: string;
  headers?: Record<string, string>;
}

export type ListMcpTools = (
  input: McpDiscoveryInput,
) => Promise<McpToolDescriptor[]>;

/** Keywords that put part of the argument list somewhere this reader does not follow. */
const DEFERRED_SCHEMA_KEYWORDS = ["$ref", "allOf", "anyOf", "oneOf"];

function describedProps(schema: unknown): McpToolProp[] | undefined {
  if (!isPlainRecord(schema)) return undefined;
  if (DEFERRED_SCHEMA_KEYWORDS.some((keyword) => keyword in schema)) {
    return undefined;
  }
  if (!isPlainRecord(schema.properties)) {
    // Closed with no properties accepts nothing, which is an answer. Open says nothing at all
    // about what it takes, so no argument passed to it can be called one it does not take.
    return schema.additionalProperties === false ? [] : undefined;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : [],
  );
  return Object.entries(schema.properties).map(([name, declared]) => ({
    name,
    type:
      isPlainRecord(declared) && typeof declared.type === "string"
        ? declared.type
        : "unknown",
    required: required.has(name),
  }));
}

function nextCursor(envelope: JsonRpcEnvelope): string | undefined {
  const result = envelope.result;
  if (!isPlainRecord(result)) return undefined;
  return typeof result.nextCursor === "string" && result.nextCursor !== ""
    ? result.nextCursor
    : undefined;
}

function describedTools(envelope: JsonRpcEnvelope, presented: readonly string[]): McpToolDescriptor[] {
  if (envelope.error !== undefined) {
    const detail = reportedText(envelope.error.message, presented);
    throw new NonRetryableError(
      `MCP server refused to list its tools${detail === undefined ? "" : `: ${detail}`}.`,
      { code: "MCP_TOOL_LIST_REFUSED", ...(detail === undefined ? {} : { detail }) },
    );
  }
  const result = envelope.result;
  if (!isPlainRecord(result) || !Array.isArray(result.tools)) {
    throw new NonRetryableError("MCP server answered without a tool list.", {
      code: "MCP_INVALID_RESPONSE",
    });
  }
  const described: McpToolDescriptor[] = [];
  for (const tool of result.tools) {
    if (!isPlainRecord(tool) || typeof tool.name !== "string") continue;
    const props = describedProps(tool.inputSchema);
    described.push({
      name: tool.name,
      ...(typeof tool.description === "string" && tool.description !== ""
        ? { description: tool.description }
        : {}),
      props: props ?? [],
      ...(props === undefined ? { propsUnreadable: true as const } : {}),
      ...(isPlainRecord(tool.inputSchema) &&
      tool.inputSchema.additionalProperties !== false
        ? { acceptsExtraProps: true as const }
        : {}),
      declaresOutputSchema: isPlainRecord(tool.outputSchema),
    });
  }
  return described;
}

export function createMcpDiscoveryFromEnv({
  fetch: rawFetch,
  resolveHost,
  timeoutMs,
  signal,
}: McpIntegrationOptions): ListMcpTools {
  const fetch = createGuardedFetch(rawFetch, {
    ...(resolveHost !== undefined ? { resolveHost } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });

  const page = async (
    url: URL,
    headers: Headers,
    cursor: string | undefined,
  ): Promise<JsonRpcEnvelope> => {
    const id = nextRequestId();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: cursor === undefined ? {} : { cursor },
    });
    const init: RequestInit = { method: "POST", headers, body };
    const envelope = await requestEnvelope(fetch, url, {
      code: "MCP_TOOL_LIST_FAILED",
      failureMode: "safe",
      maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
      acceptErrorResponse: (status) => UNAUTHORIZED_STATUSES.has(status),
      init,
    });
    if (UNAUTHORIZED_STATUSES.has(envelope.status)) {
      throw unauthorizedListing(envelope.status);
    }
    const frame = responseFrame(envelope.body, id);
    // Read once so a refusal throws here, where the presented values are still in scope.
    describedTools(frame, presentedRequestValues(url, init));
    return frame;
  };

  return async (input) => {
    const url = discoveryUrl(input.url);
    const lifecycle = await initializeSession(fetch, url, input, unauthorizedListing);
    const headers = requestHeaders(input, "tools/list", undefined, lifecycle);
    const described: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let read = 0; read < MAX_TOOL_LIST_PAGES; read += 1) {
      const frame = await page(url, headers, cursor);
      described.push(...describedTools(frame, []));
      cursor = nextCursor(frame);
      if (cursor === undefined) break;
    }
    return described;
  };
}

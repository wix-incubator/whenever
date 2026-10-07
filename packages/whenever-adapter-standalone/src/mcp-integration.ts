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
  MAX_PROVIDER_DETAIL_LENGTH,
  presentedRequestValues,
  redactReportedText,
  requestEnvelope,
  withoutPresentedValues,
} from "./http";
import {
  describeProviderInputRefusal,
  providerInputRefusalMessage,
} from "./provider-input-refusal";
import { strictJsonSnapshot, strictJsonViolation } from "./strict-json";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

const MCP_CLIENT_NAME = "wix-whenever-workflow";
const MCP_CLIENT_VERSION = "1";

// Newest first, and narrow on purpose: a revision belongs here only when this client reads its
// whole wire shape, not merely when it can address a request to it. 2025-03-26 is absent because
// it permits a batched array where this reads a single response frame.
const MCP_SPEAKABLE_VERSIONS = ["2025-11-25", "2025-06-18"];

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
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

let nextRequestId = 0;

const VERSION_REFUSED = /unsupported protocol version/iu;

export const MCP_INPUT_REJECTED = "MCP_INPUT_REJECTED";

/**
 * A JSON-RPC error frame refusing the arguments, which a server sends instead of a result. The
 * evidence is the frame, never the wording: a late check reports through `isError` in the same words.
 */
export const MCP_ARGUMENTS_REFUSED = "MCP_ARGUMENTS_REFUSED";

export const MCP_TOOL_LIST_UNAUTHORIZED = "MCP_TOOL_LIST_UNAUTHORIZED";

const UNAUTHORIZED_STATUSES = new Set([401, 403]);

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

function invalidRequest(message: string): NonRetryableError {
  return new NonRetryableError(`Invalid MCP tool call: ${message}.`, {
    code: "INVALID_MCP_REQUEST",
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

function requestHeaders(
  input: { headers?: Record<string, string> },
  method: string,
  toolName?: string,
  lifecycle?: McpLifecycle,
): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input.headers);
  } catch {
    throw invalidRequest("headers contain an invalid HTTP header");
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set(
    "mcp-protocol-version",
    lifecycle?.protocolVersion ?? MCP_PROTOCOL_VERSION,
  );
  headers.set("mcp-method", method);
  if (toolName !== undefined) headers.set("mcp-name", toolName);
  // The handshake owns this header. An author who supplies one is naming a session this client
  // never opened, so it is dropped rather than sent under our own initialization.
  headers.delete("mcp-session-id");
  if (lifecycle?.sessionId !== undefined) {
    headers.set("mcp-session-id", lifecycle.sessionId);
  }
  return headers;
}

/**
 * The revision the server agreed to speak, and the session it minted if it minted one. A server
 * that mints none is stateless and must not be sent a session header at all.
 */
interface McpLifecycle {
  protocolVersion: string;
  sessionId?: string;
}

const REVISION = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A legacy server names its revisions in the message; a modern one lists them in `data.supported`.
 * Only a refusal that says it is about the revision may drive a second attempt, and only
 * revision-shaped values are read out of one: everything here is the server's own text, so a
 * refusal for any other reason must not be retried, and none of it may be quoted back.
 */
function versionsNamedInRefusal(body: unknown, offered: string): string[] {
  if (!isPlainRecord(body) || !isPlainRecord(body.error)) return [];
  const { error } = body;
  if (typeof error.message !== "string" || !VERSION_REFUSED.test(error.message)) {
    return [];
  }
  const listed = isPlainRecord(error.data) ? error.data.supported : undefined;
  const named = Array.isArray(listed)
    ? listed.filter((version): version is string => typeof version === "string")
    : [...error.message.matchAll(/\d{4}-\d{2}-\d{2}/gu)].map(
        (match) => match[0],
      );
  // The refusal names the rejected revision too, and offering it again would loop.
  return named
    .filter((version) => REVISION.test(version))
    .filter((version) => version !== offered);
}

function initializeBody(id: number, version: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    },
  });
}

async function initializeSession(
  fetch: FetchLike,
  url: URL,
  input: { headers?: Record<string, string> },
  /** Set only by discovery, so a tool call keeps its own status classification. */
  classifyUnauthorized = false,
): Promise<McpLifecycle> {
  const attempt = async (
    version: string,
  ): Promise<{ id: number; envelope: HttpEnvelope; init: RequestInit }> => {
    nextRequestId += 1;
    const id = nextRequestId;
    const init: RequestInit = {
      method: "POST",
      headers: requestHeaders(input, "initialize", undefined, {
        protocolVersion: version,
      }),
      body: initializeBody(id, version),
    };
    const envelope = await requestEnvelope(fetch, url, {
      code: "MCP_INITIALIZE_FAILED",
      failureMode: "safe",
      maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
      // Read past exactly one refusal shape: a rejected revision is answered with the ones the
      // server does speak. Anything else keeps its status classification, so a transient 429 or
      // 503 on the handshake stays retryable instead of failing the read for good.
      acceptErrorResponse: (status, body) =>
        (status === 400 && versionsNamedInRefusal(body, version).length > 0) ||
        (classifyUnauthorized && UNAUTHORIZED_STATUSES.has(status)),
      init,
    });
    return { id, envelope, init };
  };

  let offered = MCP_PROTOCOL_VERSION;
  let { id, envelope, init } = await attempt(offered);
  const named = versionsNamedInRefusal(envelope.body, offered);
  if (named.length > 0) {
    const agreed = MCP_SPEAKABLE_VERSIONS.find((version) =>
      named.includes(version),
    );
    if (agreed === undefined) {
      throw new NonRetryableError(
        `MCP server speaks no protocol revision this supports. It offered ${String(named.length)}, none of them ${MCP_SPEAKABLE_VERSIONS.join(" or ")}.`,
        { code: "MCP_VERSION_UNSUPPORTED" },
      );
    }
    offered = agreed;
    ({ id, envelope, init } = await attempt(offered));
  }

  if (classifyUnauthorized && UNAUTHORIZED_STATUSES.has(envelope.status)) {
    throw unauthorizedListing(envelope.status);
  }

  const frame = responseFrame(envelope.body, id);
  if (frame.error !== undefined) {
    const detail = reportedText(
      frame.error.message,
      presentedRequestValues(url, init),
    );
    throw new NonRetryableError(
      `MCP server refused to initialize${detail === undefined ? "" : `: ${detail}`}.`,
      {
        code: "MCP_INITIALIZE_FAILED",
        ...(detail === undefined ? {} : { detail }),
      },
    );
  }
  if (
    !isPlainRecord(frame.result) ||
    typeof frame.result.protocolVersion !== "string"
  ) {
    throw new NonRetryableError(
      "MCP server answered the handshake without naming a protocol revision.",
      { code: "MCP_INVALID_RESPONSE" },
    );
  }
  const negotiated = frame.result.protocolVersion;
  if (!MCP_SPEAKABLE_VERSIONS.includes(negotiated)) {
    throw new NonRetryableError(
      `MCP server chose protocol revision ${negotiated}, which this does not speak.`,
      { code: "MCP_VERSION_UNSUPPORTED" },
    );
  }
  const minted = envelope.headers["mcp-session-id"];
  const lifecycle: McpLifecycle = {
    protocolVersion: negotiated,
    ...(minted === undefined || minted === "" ? {} : { sessionId: minted }),
  };

  // The revision requires this of the client, and the transport answers an accepted notification
  // with 202, so a server that rejects it has not completed a lifecycle this may build on.
  await requestEnvelope(fetch, url, {
    code: "MCP_INITIALIZE_FAILED",
    failureMode: "safe",
    maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
    init: {
      method: "POST",
      headers: requestHeaders(
        input,
        "notifications/initialized",
        undefined,
        lifecycle,
      ),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    },
  });

  return lifecycle;
}

function requestBody(
  input: McpToolCallInput,
  version: string = MCP_PROTOCOL_VERSION,
): { id: number; body: string } {
  nextRequestId += 1;
  const id = nextRequestId;
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

function streamFrames(body: string): unknown[] {
  const frames: unknown[] = [];
  for (const event of body.split(/(?:\r\n|\r|\n){2}/u)) {
    const payload = event
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /u, ""))
      .join("\n");
    if (payload.trim() === "") continue;
    try {
      frames.push(JSON.parse(payload));
    } catch {
      continue;
    }
  }
  return frames;
}

function responseFrame(body: unknown, id: number): JsonRpcEnvelope {
  const candidates = typeof body === "string" ? streamFrames(body) : [body];
  for (const candidate of candidates) {
    if (!isPlainRecord(candidate)) continue;
    // A frame carrying `method` is a notification or a request of the server's own, never an answer.
    if (candidate.method !== undefined) continue;
    if (candidate.id !== id) continue;
    if (!("result" in candidate) && !("error" in candidate)) continue;
    return candidate as JsonRpcEnvelope;
  }
  throw new NonRetryableError("MCP server did not answer this tool call.", {
    code: "MCP_INVALID_RESPONSE",
  });
}

function reportedText(
  value: unknown,
  presented: readonly string[],
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return redactReportedText(withoutPresentedValues(value, presented)).slice(
    0,
    MAX_PROVIDER_DETAIL_LENGTH,
  );
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
}: McpIntegrationOptions): McpIntegration {
  const guard = {
    ...(resolveHost !== undefined ? { resolveHost } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
  };
  const fetch = createGuardedFetch(rawFetch, guard);
  const probeFetch =
    rawProbeFetch === undefined ? fetch : createGuardedFetch(rawProbeFetch, guard);

  const call = async (
    failureMode: "safe" | "write",
    rawInput: unknown,
  ): Promise<McpToolResult> => {
    const { input, url } = prepareMcpToolCallInput(rawInput);
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

function discoveryUrl(value: unknown): URL {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidRequest("url must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest(`url is not a usable address: ${value}`);
  }
  assertAllowedEgressUrl(url);
  return url;
}

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
    nextRequestId += 1;
    const id = nextRequestId;
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
    const lifecycle = await initializeSession(fetch, url, input, true);
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

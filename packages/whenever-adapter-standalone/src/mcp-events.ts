import { NonRetryableError, WorkflowError } from "@wix/whenever-workflow-sdk";

import { createGuardedFetch } from "./egress";
import { type FetchLike, HTTP_RESPONSE_BODY_LIMIT_BYTES, requestEnvelope } from "./http";
import type { McpIntegrationOptions } from "./mcp-integration";
import {
  discoveryUrl,
  initializeSession,
  invalidRequest,
  isPlainRecord,
  type JsonRpcEnvelope,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  type McpLifecycle,
  nextRequestId,
  requestHeaders,
  responseFrame,
  UNAUTHORIZED_STATUSES,
} from "./mcp-transport";

export const MCP_EVENTS_EXTENSION = "io.modelcontextprotocol/events";
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

export type McpEventDeliveryMode = "poll" | "push" | "webhook";

export interface McpEventsTarget {
  url: string;
  headers?: Record<string, string>;
}

export interface McpEventDescriptor {
  name: string;
  description?: string;
  delivery: McpEventDeliveryMode[];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

export interface McpEventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: string | null;
}

export interface McpEventPollResult {
  events: McpEventOccurrence[];
  cursor: string | null;
  truncated: boolean;
  hasMore: boolean;
  nextPollMs?: number;
}

export interface McpEventDeliveryStatus {
  active: boolean;
  lastDeliveryAt?: string | null;
  lastError?: string | null;
  failedSince?: string;
  throttled?: boolean;
  retryAfterMs?: number;
}

export interface McpEventSubscribeResult {
  id: string;
  refreshBefore: string | null;
  cursor: string | null;
  truncated: boolean;
  deliveryStatus?: McpEventDeliveryStatus;
}

export type McpEventListResult =
  | { supported: false }
  | { supported: true; events: McpEventDescriptor[] };

export interface McpEventPollRequest {
  name: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  maxAgeMs?: number;
  maxEvents?: number;
}

export interface McpEventSubscribeRequest {
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  cursor: string | null;
  maxAgeMs?: number;
  ttlMs?: number;
}

export interface McpEventUnsubscribeRequest {
  name: string;
  arguments: Record<string, unknown>;
  url: string;
}

export interface McpEventsClient {
  list(target: McpEventsTarget): Promise<McpEventListResult>;
  poll(target: McpEventsTarget, request: McpEventPollRequest): Promise<McpEventPollResult>;
  subscribe(target: McpEventsTarget, request: McpEventSubscribeRequest): Promise<McpEventSubscribeResult>;
  unsubscribe(target: McpEventsTarget, request: McpEventUnsubscribeRequest): Promise<void>;
}

export type McpEventsErrorCode =
  | "MCP_EVENTS_UNSUPPORTED"
  | "MCP_EVENTS_UNAUTHORIZED"
  | "MCP_EVENTS_RPC_ERROR"
  | "MCP_INVALID_RESPONSE"
  | "MCP_SERVER_UNREACHABLE";

export class McpEventsError extends NonRetryableError {
  declare readonly code: McpEventsErrorCode;
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  /** The server's callback-failure category, carried only for CallbackEndpointError. */
  readonly reason?: string;

  constructor(
    code: McpEventsErrorCode,
    message: string,
    details: { rpcCode?: number; httpStatus?: number; reason?: string } = {},
  ) {
    super(message, { code });
    this.rpcCode = details.rpcCode;
    this.httpStatus = details.httpStatus;
    this.reason = details.reason;
  }
}

const DELIVERY_MODES: ReadonlySet<string> = new Set(["poll", "push", "webhook"]);
const MAX_EVENT_LIST_PAGES = 20;
const MAX_EVENT_ID_LENGTH = 200;
const HEADER_MISMATCH = -32020;
const CALLBACK_ENDPOINT_ERROR = -32027;
/** ChatGPT's dialect, and servers built for it, still answer with the draft's numbering for the SEP's codes. */
const DRAFT_ERROR_CODES: ReadonlyMap<number, number> = new Map([
  [-32011, -32023],
  [-32012, -32024],
  [-32013, -32025],
  [-32014, -32026],
  [-32015, -32027],
]);
const CALLBACK_REASON = /^[a-z\d_]{1,40}$/u;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const PLAIN_HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;
const SENTINEL = /^=\?base64\?.*\?=$/iu;
const HEADER_VALUE_TYPES = new Set(["string", "integer", "boolean"]);
const WEBHOOK_SECRET = /^whsec_([A-Za-z0-9+/]+=*)$/u;
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const CLIENT_CAPABILITIES = { extensions: { [MCP_EVENTS_EXTENSION]: {} } };

interface EventsSession {
  url: URL;
  target: McpEventsTarget;
  /** Absent for the modern revision, which is stateless and carries its lifecycle in `_meta`. */
  lifecycle?: McpLifecycle;
  capabilities: Record<string, unknown>;
}

function modernMeta(): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    "io.modelcontextprotocol/clientCapabilities": CLIENT_CAPABILITIES,
  };
}

function unauthorized(status: number): McpEventsError {
  return new McpEventsError(
    "MCP_EVENTS_UNAUTHORIZED",
    `MCP server refused the events request without authorization (${String(status)}).`,
    { httpStatus: status },
  );
}

function invalidResponse(what: string): McpEventsError {
  return new McpEventsError("MCP_INVALID_RESPONSE", `MCP server answered ${what} with a malformed result.`);
}

/** Header-safe as given, or carried in the transport's Base64 sentinel. */
function headerValue(value: string): string {
  if (PLAIN_HEADER_VALUE.test(value) && !SENTINEL.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCharCode(...bytes))}?=`;
}

interface HeaderAnnotation {
  header: string;
  path: string[];
}

/**
 * Every `x-mcp-header` in the schema, or undefined when one breaks the transport constraints: an
 * annotation must sit on a string, integer or boolean property reached through `properties` only,
 * and carry a token name unique without regard to case.
 */
function headerAnnotations(schema: Record<string, unknown>): HeaderAnnotation[] | undefined {
  const found: HeaderAnnotation[] = [];
  let valid = true;
  const visit = (node: unknown, path: string[] | undefined): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, undefined);
      return;
    }
    if (!isPlainRecord(node)) return;
    if ("x-mcp-header" in node) {
      const header = node["x-mcp-header"];
      if (
        path === undefined || path.length === 0 || typeof header !== "string" ||
        !HEADER_TOKEN.test(header) || typeof node.type !== "string" || !HEADER_VALUE_TYPES.has(node.type)
      ) {
        valid = false;
      } else {
        found.push({ header, path });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && isPlainRecord(child) && path !== undefined) {
        for (const [name, property] of Object.entries(child)) visit(property, [...path, name]);
      } else {
        visit(child, undefined);
      }
    }
  };
  visit(schema, []);
  const names = found.map(({ header }) => header.toLowerCase());
  return valid && new Set(names).size === names.length ? found : undefined;
}

function paramHeaders(descriptor: McpEventDescriptor, args: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { header, path } of headerAnnotations(descriptor.inputSchema) ?? []) {
    let value: unknown = args;
    for (const key of path) value = isPlainRecord(value) ? value[key] : undefined;
    if (typeof value === "string") headers[`mcp-param-${header}`] = headerValue(value);
    else if (typeof value === "boolean") headers[`mcp-param-${header}`] = String(value);
    else if (typeof value === "number" && Number.isInteger(value)) headers[`mcp-param-${header}`] = String(value);
  }
  return headers;
}

function descriptorOf(value: unknown): McpEventDescriptor {
  if (
    !isPlainRecord(value) || typeof value.name !== "string" || value.name === "" ||
    !Array.isArray(value.delivery) || value.delivery.length === 0 ||
    !value.delivery.every((mode) => typeof mode === "string" && DELIVERY_MODES.has(mode)) ||
    !isPlainRecord(value.inputSchema) || !isPlainRecord(value.payloadSchema) ||
    (value.description !== undefined && typeof value.description !== "string")
  ) {
    throw invalidResponse("events/list");
  }
  return {
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    delivery: [...new Set(value.delivery as McpEventDeliveryMode[])],
    inputSchema: value.inputSchema,
    payloadSchema: value.payloadSchema,
  };
}

function occurrenceOf(value: unknown): McpEventOccurrence {
  if (
    !isPlainRecord(value) || typeof value.eventId !== "string" || value.eventId === "" ||
    value.eventId.length > MAX_EVENT_ID_LENGTH || typeof value.name !== "string" || value.name === "" ||
    typeof value.timestamp !== "string" || value.timestamp === "" || !isPlainRecord(value.data) ||
    (value.cursor !== undefined && value.cursor !== null && typeof value.cursor !== "string")
  ) {
    throw invalidResponse("events/poll");
  }
  return {
    eventId: value.eventId,
    name: value.name,
    timestamp: value.timestamp,
    data: value.data,
    cursor: typeof value.cursor === "string" ? value.cursor : null,
  };
}

function optionalBoolean(value: unknown, what: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw invalidResponse(what);
  return value;
}

function cursorOf(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidResponse(what);
  return value;
}

function pollResultOf(result: unknown): McpEventPollResult {
  if (!isPlainRecord(result) || !Array.isArray(result.events)) throw invalidResponse("events/poll");
  const nextPollMs = result.nextPollMs;
  return {
    events: result.events.map(occurrenceOf),
    cursor: cursorOf(result.cursor, "events/poll"),
    truncated: optionalBoolean(result.truncated, "events/poll"),
    hasMore: optionalBoolean(result.hasMore, "events/poll"),
    ...(typeof nextPollMs === "number" && Number.isSafeInteger(nextPollMs) && nextPollMs > 0 ? { nextPollMs } : {}),
  };
}

function deliveryStatusOf(value: unknown): McpEventDeliveryStatus {
  if (!isPlainRecord(value) || typeof value.active !== "boolean") throw invalidResponse("events/subscribe");
  const nullableString = (field: unknown): field is string | null => field === null || typeof field === "string";
  return {
    active: value.active,
    ...(nullableString(value.lastDeliveryAt) ? { lastDeliveryAt: value.lastDeliveryAt } : {}),
    ...(nullableString(value.lastError) ? { lastError: value.lastError } : {}),
    ...(typeof value.failedSince === "string" ? { failedSince: value.failedSince } : {}),
    ...(typeof value.throttled === "boolean" ? { throttled: value.throttled } : {}),
    ...(typeof value.retryAfterMs === "number" && Number.isSafeInteger(value.retryAfterMs) && value.retryAfterMs >= 0
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
  };
}

function subscribeResultOf(result: unknown): McpEventSubscribeResult {
  if (
    !isPlainRecord(result) || typeof result.id !== "string" || result.id === "" ||
    !(result.refreshBefore === null || (typeof result.refreshBefore === "string" && !Number.isNaN(Date.parse(result.refreshBefore))))
  ) {
    throw invalidResponse("events/subscribe");
  }
  return {
    id: result.id,
    refreshBefore: result.refreshBefore,
    cursor: cursorOf(result.cursor, "events/subscribe"),
    truncated: optionalBoolean(result.truncated, "events/subscribe"),
    ...(result.deliveryStatus === undefined ? {} : { deliveryStatus: deliveryStatusOf(result.deliveryStatus) }),
  };
}

function assertWebhookDelivery(request: McpEventSubscribeRequest): void {
  const secret = WEBHOOK_SECRET.exec(request.secret);
  let bytes = 0;
  if (secret !== null) {
    try {
      bytes = atob(secret[1]).length;
    } catch {
      bytes = 0;
    }
  }
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    throw invalidRequest("secret must be whsec_ followed by the base64 of 24 to 64 bytes");
  }
  let callback: URL;
  try {
    callback = new URL(request.url);
  } catch {
    throw invalidRequest("callback url is not a usable address");
  }
  if (callback.protocol !== "https:") throw invalidRequest("callback url must use https");
}

function supportsEvents(capabilities: Record<string, unknown>): boolean {
  const extensions = capabilities.extensions;
  // The earlier draft declared a top-level `events` capability, and a shipping server still does.
  return (isPlainRecord(extensions) && isPlainRecord(extensions[MCP_EVENTS_EXTENSION])) || isPlainRecord(capabilities.events);
}

/** Transport failures keep their own classification only where a caller acts on it: egress and caller input. */
async function classified<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof McpEventsError || !(error instanceof WorkflowError)) throw error;
    if (error.code === "HTTP_EGRESS_BLOCKED" || error.code === "INVALID_MCP_REQUEST") throw error;
    if (error.code === "MCP_VERSION_UNSUPPORTED") {
      throw new McpEventsError("MCP_EVENTS_UNSUPPORTED", error.message);
    }
    if (error.code === "MCP_INVALID_RESPONSE") throw new McpEventsError("MCP_INVALID_RESPONSE", error.message);
    throw new McpEventsError("MCP_SERVER_UNREACHABLE", error.message);
  }
}

export function createMcpEventsClient({ fetch: rawFetch, resolveHost, timeoutMs, signal }: McpIntegrationOptions): McpEventsClient {
  const fetch: FetchLike = createGuardedFetch(rawFetch, {
    ...(resolveHost !== undefined ? { resolveHost } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });

  const discover = async (target: McpEventsTarget): Promise<EventsSession> => {
    const url = discoveryUrl(target.url);
    const id = nextRequestId();
    const envelope = await requestEnvelope(fetch, url, {
      code: "MCP_SERVER_UNREACHABLE",
      failureMode: "safe",
      maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
      // A server of an earlier revision refuses this request in many shapes; each one means "not modern".
      acceptErrorResponse: (status) => status >= 400 && status < 500 && status !== 408 && status !== 429,
      init: {
        method: "POST",
        headers: requestHeaders(target, "server/discover", undefined, { protocolVersion: MCP_MODERN_PROTOCOL_VERSION }),
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: modernMeta() } }),
      },
    });
    if (UNAUTHORIZED_STATUSES.has(envelope.status)) throw unauthorized(envelope.status);
    if (envelope.status < 300) {
      let frame: JsonRpcEnvelope | undefined;
      try {
        frame = responseFrame(envelope.body, id);
      } catch {
        frame = undefined;
      }
      const result = frame?.result;
      if (
        isPlainRecord(result) && Array.isArray(result.supportedVersions) &&
        result.supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)
      ) {
        return { url, target, capabilities: isPlainRecord(result.capabilities) ? result.capabilities : {} };
      }
    }
    const lifecycle = await initializeSession(fetch, url, target, unauthorized, CLIENT_CAPABILITIES);
    return { url, target, lifecycle, capabilities: lifecycle.capabilities };
  };

  const send = async (
    session: EventsSession,
    method: string,
    params: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonRpcEnvelope> => {
    const id = nextRequestId();
    const name = typeof params.name === "string" ? headerValue(params.name) : undefined;
    const headers = requestHeaders(
      session.target,
      method,
      name,
      session.lifecycle ?? { protocolVersion: MCP_MODERN_PROTOCOL_VERSION },
    );
    for (const [header, value] of Object.entries(extraHeaders)) headers.set(header, value);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: session.lifecycle === undefined ? { ...params, _meta: modernMeta() } : params,
    });
    const envelope = await requestEnvelope(fetch, session.url, {
      code: "MCP_SERVER_UNREACHABLE",
      failureMode: "safe",
      maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
      // Refusals such as HeaderMismatch arrive as a JSON-RPC error under a 4xx status.
      acceptErrorResponse: (status, answer) =>
        UNAUTHORIZED_STATUSES.has(status) ||
        (status >= 400 && status < 500 && isPlainRecord(answer) && isPlainRecord(answer.error)),
      init: { method: "POST", headers, body },
    });
    if (UNAUTHORIZED_STATUSES.has(envelope.status)) throw unauthorized(envelope.status);
    const frame = responseFrame(envelope.body, id);
    if (frame.error !== undefined) {
      const rawCode = typeof frame.error.code === "number" ? frame.error.code : undefined;
      const rpcCode = rawCode === undefined ? undefined : (DRAFT_ERROR_CODES.get(rawCode) ?? rawCode);
      const data = frame.error.data;
      const reason = rpcCode === CALLBACK_ENDPOINT_ERROR && isPlainRecord(data) && typeof data.reason === "string" &&
        CALLBACK_REASON.test(data.reason)
        ? data.reason
        : undefined;
      throw new McpEventsError(
        "MCP_EVENTS_RPC_ERROR",
        `MCP server refused ${method}${rpcCode === undefined ? "" : ` (${String(rpcCode)})`}.`,
        { ...(rpcCode === undefined ? {} : { rpcCode }), ...(reason === undefined ? {} : { reason }), httpStatus: envelope.status },
      );
    }
    return frame;
  };

  const listDescriptors = async (session: EventsSession): Promise<McpEventDescriptor[]> => {
    const described: McpEventDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_EVENT_LIST_PAGES; page += 1) {
      const { result } = await send(session, "events/list", cursor === undefined ? {} : { cursor });
      if (!isPlainRecord(result) || !Array.isArray(result.events)) throw invalidResponse("events/list");
      described.push(...result.events.map(descriptorOf).filter((descriptor) => headerAnnotations(descriptor.inputSchema) !== undefined));
      cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return described;
  };

  const supportedSession = async (target: McpEventsTarget): Promise<EventsSession> => {
    const session = await discover(target);
    if (!supportsEvents(session.capabilities)) {
      throw new McpEventsError("MCP_EVENTS_UNSUPPORTED", "MCP server does not advertise the MCP Events extension.");
    }
    return session;
  };

  /** Sent bare first; a HeaderMismatch re-reads the event type once and mirrors what it annotates. */
  const named = async (
    target: McpEventsTarget,
    method: string,
    params: { name: string; arguments: Record<string, unknown> } & Record<string, unknown>,
  ): Promise<unknown> => {
    const session = await supportedSession(target);
    try {
      return (await send(session, method, params)).result;
    } catch (error) {
      if (!(error instanceof McpEventsError) || error.rpcCode !== HEADER_MISMATCH) throw error;
      const descriptor = (await listDescriptors(session)).find(({ name }) => name === params.name);
      if (descriptor === undefined) throw error;
      return (await send(session, method, params, paramHeaders(descriptor, params.arguments))).result;
    }
  };

  return {
    list: async (target) => classified(async () => {
      const session = await discover(target);
      if (!supportsEvents(session.capabilities)) return { supported: false };
      return { supported: true, events: await listDescriptors(session) };
    }),
    poll: async (target, request) => classified(async () => pollResultOf(await named(target, "events/poll", {
      name: request.name,
      arguments: request.arguments,
      cursor: request.cursor,
      ...(request.maxAgeMs === undefined ? {} : { maxAgeMs: request.maxAgeMs }),
      ...(request.maxEvents === undefined ? {} : { maxEvents: request.maxEvents }),
    }))),
    subscribe: async (target, request) => {
      assertWebhookDelivery(request);
      return classified(async () => subscribeResultOf(await named(target, "events/subscribe", {
        name: request.name,
        arguments: request.arguments,
        delivery: { mode: "webhook", url: request.url, secret: request.secret },
        cursor: request.cursor,
        ...(request.maxAgeMs === undefined ? {} : { maxAgeMs: request.maxAgeMs }),
        ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
      })));
    },
    unsubscribe: async (target, request) => classified(async () => {
      await named(target, "events/unsubscribe", {
        name: request.name,
        arguments: request.arguments,
        delivery: { url: request.url },
      });
    }),
  };
}

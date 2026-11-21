import { NonRetryableError } from "@wix/whenever-workflow-sdk";

import { assertAllowedEgressUrl } from "./egress";
import {
  type FetchLike,
  HTTP_RESPONSE_BODY_LIMIT_BYTES,
  type HttpEnvelope,
  MAX_PROVIDER_DETAIL_LENGTH,
  presentedRequestValues,
  redactReportedText,
  requestEnvelope,
  withoutPresentedValues,
} from "./http";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const MCP_CLIENT_NAME = "wix-whenever-workflow";
export const MCP_CLIENT_VERSION = "1";

// Newest first, and narrow on purpose: a revision belongs here only when this client reads its
// whole wire shape, not merely when it can address a request to it. 2025-03-26 is absent because
// it permits a batched array where this reads a single response frame.
const MCP_SPEAKABLE_VERSIONS = ["2025-11-25", "2025-06-18"];

export interface JsonRpcEnvelope {
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

let requestCounter = 0;

export function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

const VERSION_REFUSED = /unsupported protocol version/iu;

export const UNAUTHORIZED_STATUSES = new Set([401, 403]);

export function invalidRequest(message: string): NonRetryableError {
  return new NonRetryableError(`Invalid MCP tool call: ${message}.`, {
    code: "INVALID_MCP_REQUEST",
  });
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requestHeaders(
  input: { headers?: Record<string, string> },
  method: string,
  toolName?: string,
  lifecycle?: Pick<McpLifecycle, "protocolVersion" | "sessionId">,
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
export interface McpLifecycle {
  protocolVersion: string;
  sessionId?: string;
  capabilities: Record<string, unknown>;
}

const REVISION = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A legacy server names its revisions in the message; a modern one lists them in `data.supported`.
 * Only a refusal that says it is about the revision may drive a second attempt, and only
 * revision-shaped values are read out of one: everything here is the server's own text, so a
 * refusal for any other reason must not be retried, and none of it may be quoted back.
 */
export function versionsNamedInRefusal(body: unknown, offered: string): string[] {
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

function initializeBody(
  id: number,
  version: string,
  capabilities: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: version,
      capabilities,
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    },
  });
}

export async function initializeSession(
  fetch: FetchLike,
  url: URL,
  input: { headers?: Record<string, string> },
  /** Set only by callers that classify a refused credential, so a tool call keeps its own status classification. */
  refuseUnauthorized?: (status: number) => Error,
  clientCapabilities: Record<string, unknown> = {},
): Promise<McpLifecycle> {
  const attempt = async (
    version: string,
  ): Promise<{ id: number; envelope: HttpEnvelope; init: RequestInit }> => {
    const id = nextRequestId();
    const init: RequestInit = {
      method: "POST",
      headers: requestHeaders(input, "initialize", undefined, {
        protocolVersion: version,
      }),
      body: initializeBody(id, version, clientCapabilities),
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
        (refuseUnauthorized !== undefined && UNAUTHORIZED_STATUSES.has(status)),
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

  if (refuseUnauthorized !== undefined && UNAUTHORIZED_STATUSES.has(envelope.status)) {
    throw refuseUnauthorized(envelope.status);
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
    capabilities: isPlainRecord(frame.result.capabilities) ? frame.result.capabilities : {},
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

export function responseFrame(body: unknown, id: number): JsonRpcEnvelope {
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

export function reportedText(
  value: unknown,
  presented: readonly string[],
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return redactReportedText(withoutPresentedValues(value, presented)).slice(
    0,
    MAX_PROVIDER_DETAIL_LENGTH,
  );
}

export function discoveryUrl(value: unknown): URL {
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

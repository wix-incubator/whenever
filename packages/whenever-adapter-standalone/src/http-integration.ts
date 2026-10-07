import {
  type HttpIntegration,
  type HttpRequestInput,
  type HttpWriteInput,
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
  requestEnvelope,
} from "./http";
import { strictJsonSnapshot, strictJsonViolation } from "./strict-json";

export interface HttpIntegrationOptions {
  fetch: FetchLike;
  resolveHost?: ResolveHost;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function targetUrl(input: unknown): URL {
  validateHttpRequestInput(input);
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new NonRetryableError(
      `Invalid request URL: ${String(input.url)}`,
      { code: "INVALID_HTTP_REQUEST" },
    );
  }
  if (input.query !== undefined) {
    for (const [key, value] of Object.entries(input.query)) {
      url.searchParams.set(key, value);
    }
  }
  assertAllowedEgressUrl(url);
  return url;
}

function writeInit(
  method: "POST" | "PUT" | "PATCH",
  input: HttpWriteInput,
): RequestInit {
  const headers = requestHeaders(input.headers);
  const init: RequestInit = { method, headers };
  if (input.body !== undefined) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    init.body = isFormContentType(headers)
      ? encodeFormBody(input.body)
      : encodeJsonBody(input.body);
  }
  return init;
}

function isFormContentType(headers: Headers): boolean {
  const declared = headers.get("content-type");
  if (declared === null) return false;
  return (
    declared.split(";")[0]?.trim().toLowerCase() ===
    "application/x-www-form-urlencoded"
  );
}

// A form field carries one scalar, so an array repeats its key and anything deeper is
// named rather than silently stringified into "[object Object]".
function encodeFormBody(value: unknown): string {
  // Walk a snapshot, never the caller's object: a throwing getter would otherwise escape as the
  // workflow's own error, unclassified, and a two-faced one could pass the check and encode
  // something else. The JSON path takes the same snapshot for the same reason.
  const snapshot = strictJsonSnapshot(value);
  if (snapshot === undefined) {
    throw invalidHttpRequest(
      "a form-encoded body must be finite, acyclic strict JSON",
    );
  }
  if (!isPlainRecord(snapshot.value)) {
    throw invalidHttpRequest(
      "a form-encoded body must be an object of fields",
    );
  }
  const params = new URLSearchParams();
  for (const [field, raw] of Object.entries(snapshot.value)) {
    for (const member of Array.isArray(raw) ? raw : [raw]) {
      params.append(field, formField(`body.${field}`, member));
    }
  }
  return withinRequestLimit(params.toString());
}

function formField(path: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const described =
    value === undefined
      ? "is undefined"
      : value === null
        ? "is null"
        : Array.isArray(value)
          ? "is a nested array"
          : typeof value === "object"
            ? "is a nested object"
            : `is a ${typeof value}`;
  throw invalidHttpRequest(
    `${path} ${described}, which a form-encoded body cannot carry`,
  );
}

function withinRequestLimit(encoded: string): string {
  if (
    new TextEncoder().encode(encoded).byteLength >
    HTTP_REQUEST_BODY_LIMIT_BYTES
  ) {
    throw invalidHttpRequest(
      `request body exceeds ${describedByteLimit(HTTP_REQUEST_BODY_LIMIT_BYTES)}`,
    );
  }
  return encoded;
}

export function prepareHttpGetInput(input: unknown): {
  input: HttpRequestInput;
  url: URL;
  headers: Headers;
} {
  const url = targetUrl(input);
  const validated = input as HttpRequestInput;
  return {
    input: validated,
    url,
    headers: requestHeaders(validated.headers),
  };
}

export function prepareHttpWriteInput(
  method: "POST" | "PUT" | "PATCH",
  input: unknown,
): { input: HttpWriteInput; url: URL; init: RequestInit } {
  const url = targetUrl(input);
  const validated = input as HttpWriteInput;
  return { input: validated, url, init: writeInit(method, validated) };
}

function requestHeaders(value: HttpRequestInput["headers"]): Headers {
  try {
    return new Headers(value);
  } catch {
    throw invalidHttpRequest("headers contain an invalid HTTP header");
  }
}

export function validateHttpRequestInput(
  input: unknown,
): asserts input is HttpRequestInput | HttpWriteInput {
  if (!isPlainRecord(input)) {
    throw invalidHttpRequest("input must be an object");
  }
  if (typeof input.url !== "string" || input.url.trim() === "") {
    throw invalidHttpRequest("url must be a non-empty string");
  }
  validateStringRecord(input.headers, "headers");
  validateStringRecord(input.query, "query");
  requestHeaders(input.headers as Record<string, string> | undefined);
}

function validateStringRecord(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!isPlainRecord(value)) {
    throw invalidHttpRequest(`${field} must be an object of strings`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim() === "" || typeof entry !== "string") {
      throw invalidHttpRequest(
        `${field} must contain non-empty names and string values`,
      );
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeJsonBody(value: unknown): string {
  // The snapshot is what gets encoded: reading the caller's object twice would let a
  // getter pass the check and then hand JSON.stringify something else.
  const snapshot = strictJsonSnapshot(value);
  if (snapshot === undefined) {
    // A getter that answers differently on the second walk leaves nothing to point at, so the
    // rule is stated alone rather than with a path that would be a guess.
    const violation = strictJsonViolation(value, "body");
    throw invalidHttpRequest(
      violation === undefined
        ? "body must be finite, acyclic strict JSON"
        : `body must be finite, acyclic strict JSON: ${violation}`,
    );
  }
  const encoded = JSON.stringify(snapshot.value);
  if (encoded === undefined) {
    throw invalidHttpRequest("body must be strict JSON");
  }
  return withinRequestLimit(encoded);
}

function invalidHttpRequest(message: string): NonRetryableError {
  return new NonRetryableError(`Invalid HTTP request: ${message}.`, {
    code: "INVALID_HTTP_REQUEST",
  });
}

export function createHttpIntegrationFromEnv({
  fetch: rawFetch,
  resolveHost,
  timeoutMs,
  signal,
}: HttpIntegrationOptions): HttpIntegration {
  const fetch = createGuardedFetch(rawFetch, {
    ...(resolveHost !== undefined ? { resolveHost } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  return {
    async get(input) {
      const { headers, url } = prepareHttpGetInput(input);
      return requestEnvelope(fetch, url, {
        code: "HTTP_REQUEST_FAILED",
        failureMode: "safe",
        maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
        init: { method: "GET", headers },
      });
    },
    async post(input) {
      const { init, url } = prepareHttpWriteInput("POST", input);
      return requestEnvelope(fetch, url, {
        code: "HTTP_REQUEST_FAILED",
        failureMode: "write",
        maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
        init,
      });
    },
    async put(input) {
      const { init, url } = prepareHttpWriteInput("PUT", input);
      return requestEnvelope(fetch, url, {
        code: "HTTP_REQUEST_FAILED",
        failureMode: "write",
        maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
        init,
      });
    },
    async patch(input) {
      const { init, url } = prepareHttpWriteInput("PATCH", input);
      return requestEnvelope(fetch, url, {
        code: "HTTP_REQUEST_FAILED",
        failureMode: "write",
        maxResponseBytes: HTTP_RESPONSE_BODY_LIMIT_BYTES,
        init,
      });
    },
  };
}

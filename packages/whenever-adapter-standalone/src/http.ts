import {
  NonRetryableError,
  RetryableError,
  WorkflowError,
} from "@wix/whenever-workflow-sdk";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface RequestJsonOptions {
  code: string;
  failureMode: "safe" | "write";
  maxResponseBytes?: number;
  init?: RequestInit;
  /**
   * Reads a non-2xx body instead of throwing, for the one shape the caller expects to find
   * there. Everything else keeps the normal status classification, so a transient 429 or 5xx
   * stays retryable.
   */
  acceptErrorResponse?: (status: number, body: unknown) => boolean;
  timeoutCode?: string;
}

export interface HttpEnvelope {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function collectHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

export const HTTP_REQUEST_BODY_LIMIT_BYTES = 1_048_576;
/** Maximum decoded response bytes, enforced while streaming regardless of compression. */
export const HTTP_RESPONSE_BODY_LIMIT_BYTES = 1_048_576;

const BYTE_UNITS = [
  ["GiB", 1_073_741_824],
  ["MiB", 1_048_576],
  ["KiB", 1024],
] as const;

// A limit written out in bytes runs to seven digits, which the detail redactor masks as a phone
// number, so the owner would never learn it. Scaled to its largest unit, any limit under 10,000 GiB
// stays below seven.
export function describedByteLimit(bytes: number): string {
  for (const [unit, size] of BYTE_UNITS) {
    if (bytes >= size) return `${String(Number((bytes / size).toFixed(2)))} ${unit}`;
  }
  return `${String(bytes)} bytes`;
}

const MACHINE_READABLE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export const NO_REASON_REPORTED = "no_reason_reported";

export function machineReadableReason(value: unknown): string {
  return codeReason(value) ?? NO_REASON_REPORTED;
}

/** Maximum composed provider detail length, including the reason and separator. */
export const MAX_PROVIDER_DETAIL_LENGTH = 600;

export function providerRejectionDetail(
  reason: string,
  reported: string | undefined,
): string | undefined {
  const named = reason === NO_REASON_REPORTED ? undefined : reason;
  const composed = [named, reported]
    .filter((part): part is string => part !== undefined)
    .join(": ");
  return composed === "" ? undefined : composed.slice(0, MAX_PROVIDER_DETAIL_LENGTH);
}

// A code is a small enumeration; a longer run of digits is an account, card or phone number.
const MAX_NUMERIC_CODE = 1_000_000;

const URI_REFERENCE = /^(?:[a-z][\w+.-]*:\/\/|about:)/iu;

function codeReason(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (URI_REFERENCE.test(value)) return undefined;
    return MACHINE_READABLE_CODE.test(value) ? value : undefined;
  }
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < MAX_NUMERIC_CODE
    ? String(value)
    : undefined;
}

const MAX_REPORTED_DETAIL_LENGTH = 500;

export function providerReportedDetail(
  body: unknown,
  reason: string,
  presented: readonly string[] = [],
): string | undefined {
  const ranked = stringLeaves(body)
    .map((leaf, order) => ({ leaf, order, rank: explanationRank(leaf) }))
    .filter((candidate) => candidate.rank !== NOT_AN_EXPLANATION)
    .sort((left, right) => left.rank - right.rank || left.order - right.order);
  for (const { leaf } of ranked) {
    const detail = printableDetail(withoutPresentedValues(leaf.value, presented));
    if (detail !== "" && detail !== reason) return detail;
  }
  return undefined;
}

/** Collects request values so credentials echoed by a provider can be redacted from errors. */
export function presentedRequestValues(
  url: string | URL,
  init: RequestInit | undefined,
): string[] {
  const values = new Set<string>();
  const present = (value: string, named: boolean): void => {
    if (values.size >= MAX_PRESENTED_VALUES) return;
    const trimmed = value.trim();
    if (trimmed === "") return;
    if (named || looksLikeAValue(trimmed)) values.add(trimmed);
  };

  for (const [name, value] of headerEntries(init?.headers)) {
    if (DESCRIBES_REQUEST.test(name)) continue;
    const named = CREDENTIAL_NAME.test(name);
    present(value, named);
    // `Authorization: Bearer <token>` is echoed without its scheme as often as with it, and a cookie
    // header is a list whose one rejected pair comes back alone.
    for (const part of value.split(/[;\s]+/u)) {
      const separator = part.indexOf("=");
      present(separator > 0 ? part.slice(separator + 1) : part, named);
    }
  }

  const target = parsedUrl(url);
  if (target !== undefined) {
    // Userinfo is a credential by position, whatever it is called.
    present(target.username, true);
    present(target.password, true);
    for (const segment of target.pathname.split("/")) present(segment, false);
    for (const [name, value] of target.searchParams) {
      const named = CREDENTIAL_NAME.test(name);
      present(value, named);
      // `searchParams` decodes, and the provider echoes back whichever form it received, so both
      // have to be masked: a token sent as `s%3A…` was collected only as `s:…`.
      present(encodeURIComponent(value), named);
    }
  }

  for (const [name, value] of presentedBodyValues(init?.body)) {
    present(value, CREDENTIAL_NAME.test(name));
  }
  return [...values];
}

const MAX_PRESENTED_VALUES = 512;

function presentedBodyValues(
  body: BodyInit | null | undefined,
): [string, string][] {
  if (body instanceof URLSearchParams) return [...body];
  if (typeof body !== "string") return [];
  const json = parsedBody(body);
  if (json !== undefined) {
    return scalarLeaves(json).map((leaf) => [leaf.key, String(leaf.value)]);
  }
  return [...new URLSearchParams(body)];
}

function parsedUrl(url: string | URL): URL | undefined {
  try {
    return new URL(typeof url === "string" ? url : url.toString());
  } catch {
    return undefined;
  }
}

function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const CREDENTIAL_NAME =
  /authorization|cookie|key|token|secret|auth|password|signature|credential/iu;

const DESCRIBES_REQUEST =
  /^(?:accept(?:-\w+)?|content-(?:type|length|encoding)|user-agent|referer|origin|host|connection|cache-control|if-(?:none-match|modified-since))$/iu;

const MIN_UNNAMED_VALUE_LENGTH = 8;
const NOT_A_PLAIN_WORD = /[^A-Za-z]|[a-z][A-Z]/u;

function looksLikeAValue(value: string): boolean {
  return (
    value.length >= MIN_UNNAMED_VALUE_LENGTH && NOT_A_PLAIN_WORD.test(value)
  );
}

function headerEntries(headers: HeadersInit | undefined): [string, string][] {
  if (headers === undefined) return [];
  try {
    return [...new Headers(headers)];
  } catch {
    return [];
  }
}

export function withoutPresentedValues(
  value: string,
  presented: readonly string[],
): string {
  let masked = value;
  for (const secret of presented) {
    masked =
      secret.length > MAX_MATCHER_VALUE_LENGTH
        ? masked.split(secret).join(REDACTED)
        : masked.replace(standaloneOccurrence(secret), REDACTED);
  }
  return masked;
}

const MAX_MATCHER_VALUE_LENGTH = 4_096;

function standaloneOccurrence(secret: string): RegExp {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // `\b` asserts a change in character class, so it only means "edge of the value" when the value's
  // own edge is a word character. Around `!` or `-` it would assert the opposite of what is wanted.
  const start = /^\w/u.test(secret) ? "\\b" : "";
  const end = /\w$/u.test(secret) ? "\\b" : "";
  return new RegExp(`${start}${escaped}${end}`, "gu");
}

const MAX_LEAF_DEPTH = 6;
const MAX_LEAVES = 256;

interface StringLeaf {
  readonly key: string;
  readonly value: string;
}

interface ScalarLeaf {
  readonly key: string;
  readonly value: string | number;
}

function stringLeaves(body: unknown): StringLeaf[] {
  const strings: StringLeaf[] = [];
  for (const leaf of collectLeaves(body, false)) {
    if (typeof leaf.value === "string") {
      strings.push({ key: leaf.key, value: leaf.value });
    }
  }
  return strings;
}

function scalarLeaves(body: unknown): ScalarLeaf[] {
  return collectLeaves(body, true);
}

function collectLeaves(body: unknown, includeNumbers: boolean): ScalarLeaf[] {
  const leaves: ScalarLeaf[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown, key: string, depth: number): void => {
    if (leaves.length >= MAX_LEAVES || depth > MAX_LEAF_DEPTH) return;
    if (typeof node === "string") {
      if (node.trim() !== "") leaves.push({ key, value: node });
      return;
    }
    if (includeNumbers && typeof node === "number") {
      leaves.push({ key, value: node });
      return;
    }
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    // An array keeps its property's name, so `errors: [{ detail }]` reads as a `detail`.
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, depth + 1);
      return;
    }
    for (const [name, child] of Object.entries(node)) visit(child, name, depth + 1);
  };
  visit(body, "", 0);
  return leaves;
}

const EXPLAINING_KEY = /message|msg|detail|description|reason|problem/iu;
const LABELLING_KEY = /title|error/iu;
const REFERENCE_KEY = /url|uri|link|docs|documentation|href/iu;
const BARE_URL = /^[a-z][\w+.-]*:\/\/\S*$/iu;
const NOT_AN_EXPLANATION = 5;

function explanationRank(leaf: StringLeaf): number {
  const explaining = EXPLAINING_KEY.test(leaf.key);
  const labelling = LABELLING_KEY.test(leaf.key);
  // A value filed under a credential's name is a credential, not an account of anything. It yields
  // to an explaining name, so `oauth_error` stays a reason rather than reading as a token.
  if (!explaining && !labelling && CREDENTIAL_NAME.test(leaf.key)) {
    return NOT_AN_EXPLANATION;
  }
  if (REFERENCE_KEY.test(leaf.key) || BARE_URL.test(leaf.value.trim())) {
    return NOT_AN_EXPLANATION;
  }
  // The body itself carries no key, so it is the whole of what the provider said: a plain-text
  // `Unauthorized` is that provider's entire explanation, not an identifier beside one.
  if (leaf.key === "") return 0;
  const explains = !MACHINE_READABLE_CODE.test(leaf.value.trim());
  if (explaining) return explains ? 0 : 2;
  if (labelling) return explains ? 1 : 3;
  return NOT_AN_EXPLANATION;
}

export function withProviderDetail(
  message: string,
  detail: string | undefined,
): string {
  return detail === undefined ? message : `${message} (provider reported: ${detail})`;
}

function nestedField(source: unknown, field: string): unknown {
  return source !== null && typeof source === "object"
    ? (source as Record<string, unknown>)[field]
    : undefined;
}

const REDACTED = "[redacted]";
// The window is twice the cap so a run straddling the cut is masked before the cut happens.
const DETAIL_WINDOW = MAX_REPORTED_DETAIL_LENGTH * 2;
const URL_QUERY = /(https?:\/\/[^\s?#]+)\?\S*/giu;
// A query string an author mistyped never became a URL, so the pattern above cannot see it. `=` is
// what tells a query pair from prose that merely ends in a question mark.
const QUERY_PAIR = /\?[^\s?#]*=\S*/gu;
// Basic-auth userinfo sits before the host, so masking from `?` onward never reached it.
const URL_USERINFO = /(\/\/)[^/@\s:]+:[^/@\s]*@/gu;
// `sk-` is OpenAI's shape; Stripe and its siblings underscore it, and those fell straight through.
const TOKEN_PREFIX =
  /\b(?:xox[abeoprs]-|xapp-|sk-|[srp]k_(?:live|test)_|gh[opsru]_|github_pat_)[\w-]+/giu;
// Case-sensitive and sized: fixed-width keys, and a loose match would swallow prose.
const OPAQUE_KEY = /\b(?:AIza[\w-]{30,40}|A(?:KIA|SIA|ROA)[0-9A-Z]{16})\b/gu;
const JSON_WEB_TOKEN = /\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]+)?/gu;
const SCHEME_TOKEN = /\b(?:bearer|basic)\s+[\w.\-~+/]+=*/giu;
const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/gu;
const DIGIT_RUN = /\+?\d(?:[\s.\-]?\d){6,62}/gu;

function maskPresentedCredentials(value: string): string {
  return value
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_QUERY, `$1?${REDACTED}`)
    .replace(QUERY_PAIR, `?${REDACTED}`)
    .replace(SCHEME_TOKEN, REDACTED)
    .replace(JSON_WEB_TOKEN, REDACTED)
    .replace(TOKEN_PREFIX, REDACTED)
    .replace(OPAQUE_KEY, REDACTED);
}

/**
 * The one redactor for any text a failure carries out of this process. There were four call sites
 * masking to three different depths, so review kept finding the path that omitted whichever rule
 * another applied — a defect that cannot exist while there is a single function to reach for.
 */
export function redactReportedText(value: string): string {
  const flat = value
    .slice(0, DETAIL_WINDOW)
    .replace(/[^\x20-\x7e]/gu, " ")
    .replace(/[();]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return maskPresentedCredentials(flat)
    .replace(EMAIL_ADDRESS, REDACTED)
    .replace(DIGIT_RUN, REDACTED);
}

function printableDetail(value: string): string {
  return redactReportedText(value).slice(0, MAX_REPORTED_DETAIL_LENGTH);
}

const NUMERIC_REASON = /^\d+$/u;

function responseErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return NO_REASON_REPORTED;

  const value = body as { error?: unknown; code?: unknown; category?: unknown };
  const candidates = [
    typeof value.error === "string" ? value.error : undefined,
    nestedField(value.error, "code"),
    nestedField(value.error, "status"),
    value.code,
    value.category,
  ];
  for (const pass of [true, false]) {
    for (const candidate of candidates) {
      const reason = codeReason(candidate);
      if (reason === undefined) continue;
      if (pass && NUMERIC_REASON.test(reason)) continue;
      return reason;
    }
  }
  const found = scalarLeaves(body)
    .filter((leaf) => CODE_KEY.test(leaf.key))
    .map((leaf) => codeReason(typeof leaf.value === "string" ? leaf.value.trim() : leaf.value))
    .filter((reason): reason is string => reason !== undefined);
  for (const pass of [true, false]) {
    for (const reason of found) {
      if (pass && NUMERIC_REASON.test(reason)) continue;
      return reason;
    }
  }
  return NO_REASON_REPORTED;
}

const CODE_KEY = /code|status|category|type/iu;

function statusLabel(response: Response): string {
  const phrase = response.statusText.trim();
  return phrase === "" ? String(response.status) : `${response.status} ${phrase}`;
}

export function responseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class ResponseBodyLimitError extends Error {}

// A refused read keeps its caller's code and class, which workflow code already sees, so the
// reason travels beside the error rather than on it.
const responseBodyLimitRefusals = new WeakSet<Error>();

export function isResponseBodyLimitRefusal(error: unknown): boolean {
  return (
    error instanceof ResponseBodyLimitError ||
    (error instanceof Error && responseBodyLimitRefusals.has(error))
  );
}

async function cancelBestEffort(cancel: () => Promise<void>): Promise<void> {
  try {
    await cancel();
  } catch {
    // Cleanup failure must not replace the response-size classification.
  }
}

export async function readResponseText(
  response: Response,
  maxBytes: number | undefined,
): Promise<string> {
  if (maxBytes === undefined) return response.text();

  const contentLength = response.headers.get("Content-Length");
  if (
    contentLength !== null &&
    Number.isSafeInteger(Number(contentLength)) &&
    Number(contentLength) > maxBytes
  ) {
    if (response.body !== null) {
      await cancelBestEffort(async () => await response.body?.cancel());
    }
    throw new ResponseBodyLimitError(
      `API response exceeds ${describedByteLimit(maxBytes)}.`,
    );
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await cancelBestEffort(async () => await reader.cancel());
        throw new ResponseBodyLimitError(
          `API response exceeds ${describedByteLimit(maxBytes)}.`,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function requestEnvelope(
  fetchImplementation: FetchLike,
  url: string | URL,
  options: RequestJsonOptions,
): Promise<HttpEnvelope> {
  let response: Response;
  try {
    response = await fetchImplementation(url, options.init);
  } catch (error) {
    throwRequestFailure(error, options);
  }

  let text: string;
  try {
    text = await readResponseText(response, options.maxResponseBytes);
  } catch (error) {
    if (error instanceof ResponseBodyLimitError) {
      if (options.failureMode === "write") {
        throw new NonRetryableError(
          "External write returned a response too large to validate safely.",
          { code: "AMBIGUOUS_EXTERNAL_WRITE" },
        );
      }
      const refusal = new NonRetryableError(error.message, { code: options.code });
      responseBodyLimitRefusals.add(refusal);
      throw refusal;
    }
    throwRequestFailure(error, options);
  }
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok && options.acceptErrorResponse?.(response.status, body) !== true) {
    // Above the message: the write may already have taken effect, so that is the whole finding.
    if (options.failureMode === "write" && response.status >= 500) {
      throw new NonRetryableError(
        `External write may have completed before the provider returned ${response.status} ${response.statusText}.`,
        { code: "AMBIGUOUS_EXTERNAL_WRITE" },
      );
    }
    const reason = responseErrorMessage(body);
    const reported = providerReportedDetail(
      body,
      reason,
      presentedRequestValues(url, options.init),
    );
    const message = withProviderDetail(
      `API request failed (${statusLabel(response)}): ${reason}`,
      reported,
    );
    const detail = providerRejectionDetail(reason, reported);
    if (
      response.status === 429 ||
      (options.failureMode === "safe" && response.status >= 500)
    ) {
      throw new RetryableError(message, {
        code: options.code,
        retryAfterMs: responseRetryAfterMs(response),
        ...(detail === undefined ? {} : { detail }),
      });
    }
    throw new NonRetryableError(message, {
      code: options.code,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  return {
    status: response.status,
    headers: collectHeaders(response.headers),
    body,
  };
}

function throwRequestFailure(
  error: unknown,
  options: RequestJsonOptions,
): never {
  if (isDeadlineError(error) && options.timeoutCode !== undefined) {
    throw new RetryableError("API request exceeded its deadline.", {
      code: options.timeoutCode,
    });
  }
  if (options.failureMode === "write") {
    throw new NonRetryableError(
      "External write may have completed before the response was observed.",
      { code: "AMBIGUOUS_EXTERNAL_WRITE" },
    );
  }
  if (error instanceof WorkflowError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new RetryableError(`API request failed: ${message}`, {
    code: options.code,
  });
}

function isDeadlineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function requestJson<T>(
  fetchImplementation: FetchLike,
  url: string | URL,
  options: RequestJsonOptions,
): Promise<T> {
  const envelope = await requestEnvelope(fetchImplementation, url, options);
  return envelope.body as T;
}

export interface ProviderInputRefusal {
  /** Argument names the provider said it needs and did not receive. */
  readonly requires: readonly string[];
  /** Argument names the provider received and would not accept. */
  readonly refused: readonly string[];
}

const REPORTED_NAME_LIMIT = 5;
const NAME_LENGTH_LIMIT = 60;
/** The tightest cap this message passes through, so it is composed to fit rather than trimmed. */
const MESSAGE_LIMIT = 300;
const SCANNED_TEXT_LIMIT = 8_000;
const NAME_SHAPE = /^[A-Za-z_$][\w$.-]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/gu;

/**
 * Third-party text on a shared service's request path, so no two adjacent quantifiers here may
 * consume the same character: three adjacent `\s*` measured ten seconds on four thousand spaces.
 */
function edged(phrases: readonly string[]): RegExp {
  return new RegExp(`(?<![\\w-])(?:${phrases.join("|")})(?![\\w-])`, "iu");
}

/** Names the input: a bare `invalid_type` also fits a result that failed validation after a write. */
const INPUT_REFUSAL = edged([
  "input validation error",
  "invalid arguments",
  "invalid params",
  "unrecognized key",
  "unrecognized_keys",
  "required property",
  "required argument",
  "required parameter",
  "is required",
]);

/**
 * Edged, not substring-matched, because the names share this text: `permission_level` would
 * otherwise read as a complaint about permissions and throw the whole refusal away.
 */
const OTHER_COMPLAINT = edged([
  "output validation",
  "result validation",
  "response validation",
  "parse the response",
  "authentication",
  "authorization",
  "unauthorized",
  "forbidden",
  "permission",
]);

// `[^}]` rather than any character: a `}` ends the issue, and reaching past one would read a later
// object's `keys` as this issue's and report a name the provider never refused.
const UNRECOGNIZED_KEYS_ARRAY =
  /"unrecognized_keys"[^}]{0,200}?"keys"\s*:\s*\[([^\]]{0,400})\]/gu;
// `unrecognized key(s) in object:` and the spellings a redactor leaves behind — that reader turns
// `(` and `)` into spaces, so the parenthesised plural cannot be matched literally.
const UNRECOGNIZED_KEYS_PROSE = /unrecognized key[^:\n]{0,32}:([^\n}\]]{1,200})/giu;
const QUOTED_NAME = /["']([^"']{1,200})["']/gu;

/** A validation issue, matched whole so a path is only read as required when its own message is. */
const ISSUE_OBJECT = /\{[^{}]{0,800}\}/gu;
const ISSUE_PATH = /"path"\s*:\s*\[([^\]]{0,200})\]/u;
// Zod 3 wrote `"message":"Required"` beside `"received":"undefined"`; Zod 4 sends neither and says
// `expected string, received undefined` in the message. The MCP SDK has moved to 4.
const ISSUE_SAYS_REQUIRED =
  /"message"\s*:\s*"Required"|"received"\s*:\s*"undefined"|received undefined/u;

/** Zod's issues flattened to prose, which is what a server sends when it reports no issue array. */
const FLATTENED_ISSUES = /invalid arguments for tool [^\n:]{0,120}:([^\n[{]{0,300})/giu;
const FLATTENED_REQUIRED = /([A-Za-z_$][\w$.-]{0,58}) Required\b/gu;
// What every validator family outside Zod reaches for, and both are common on a server written
// outside TypeScript.
const REQUIRED_PROSE: readonly RegExp[] = [
  /(?:^|[:\n"'])[ \t]{0,4}(?!(?:authentication|authorization|permission|approval) is required)([A-Za-z_$][\w$.-]{0,58}) is required(?![\w-])/giu,
  /["']([A-Za-z_$][\w$.-]{0,58})["'] is a required property/giu,
  /missing required (?:argument|property|parameter)[^\w\n]{0,4}([A-Za-z_$][\w$.-]{0,58})/giu,
];

const SENT_VALUE_LIMIT = 64;
const SENT_VALUE_MIN_LENGTH = 3;
const SENT_VALUE_MAX_DEPTH = 6;

/**
 * The string values a call sent, so a forged issue inside the server's echo cannot be read as one.
 * Values only, never keys — a key is the name this is trying to report.
 */
function valuesSentWith(sent: unknown): string[] {
  const values: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (values.length >= SENT_VALUE_LIMIT || depth > SENT_VALUE_MAX_DEPTH) return;
    if (typeof value === "string") {
      if (value.trim().length >= SENT_VALUE_MIN_LENGTH) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const nested of Object.values(value)) walk(nested, depth + 1);
    }
  };
  walk(sent, 0);
  return values;
}

/**
 * The argument names a provider's refusal named; `sent` is what the call passed, masked so an echo
 * cannot forge one. Says nothing about whether the tool ran — only the caller's shape settles that.
 */
export function describeProviderInputRefusal(
  error: unknown,
  sent: unknown,
): ProviderInputRefusal | undefined {
  const raw = refusalText(error);
  if (raw === undefined) return undefined;
  // Gated on the provider's own words, then read from the masked copy. The gate alone names
  // nothing, so an echoed value cannot forge a name — but masking first let one hide a marker.
  if (!INPUT_REFUSAL.test(raw)) return undefined;
  const text = withoutTokens(raw, valuesSentWith(sent));
  const requires = boundedNames(requiredNames(text));
  const refused = boundedNames(refusedNames(text));
  if (requires.length === 0 && refused.length === 0) return undefined;
  // The names are blanked before the exclusion runs, because they sit in the same text: an
  // argument named exactly `permission` read as a complaint about permissions and was thrown away.
  if (OTHER_COMPLAINT.test(withoutTokens(text, [...requires, ...refused]))) {
    return undefined;
  }
  return { requires, refused };
}

/**
 * Names first, since every caller bounds this string and they are the part that says what to change.
 * `repair` is the caller's verbatim: only it knows where the names came from.
 */
export function providerInputRefusalMessage(
  operationId: string,
  refusal: ProviderInputRefusal,
  repair: string,
): string {
  // Composed to fit rather than trimmed to fit, and the refused name goes first because it is the
  // one the author has to remove. Trimming a finished sentence is what cut it off before.
  for (let names = REPORTED_NAME_LIMIT; names >= 1; names -= 1) {
    const message = refusalSentence(operationId, refusal, repair, names);
    if (message.length <= MESSAGE_LIMIT) return message;
  }
  // Nothing composed short enough, so the advice goes rather than a sentence ending mid-word.
  return refusalSentence(operationId, refusal, "", 1).slice(0, MESSAGE_LIMIT);
}

function refusalSentence(
  operationId: string,
  refusal: ProviderInputRefusal,
  repair: string,
  names: number,
): string {
  const clauses: string[] = [];
  if (refusal.refused.length > 0) {
    clauses.push(`does not accept ${list(refusal.refused.slice(0, names))}`);
  }
  if (refusal.requires.length > 0) {
    clauses.push(`requires ${list(refusal.requires.slice(0, names))}`);
  }
  const named =
    clauses.length === 0
      ? "was refused over its arguments"
      : `was refused over its argument names: the provider ${clauses.join(" and it ")}`;
  return `${safeName(operationId)} ${named}.${repair === "" ? "" : ` ${repair}`}`;
}

function refusalText(error: unknown): string | undefined {
  const raw =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : undefined;
  if (raw === undefined) return undefined;
  // Bounded first, so nothing downstream walks a longer string than the patterns will read.
  const text = raw.slice(0, SCANNED_TEXT_LIMIT).trim();
  return text === "" ? undefined : text;
}

const MASK = "[sent]";
const NAME_CHARACTER = /[\w$.-]/u;

/**
 * Blanks each token only where it stands alone. A substring replacement ate the name it was meant
 * to protect: a sent value of `user` turned a refusal naming `userId` into `[sent]Id`.
 */
function withoutTokens(text: string, tokens: readonly string[]): string {
  let masked = text;
  for (const token of tokens) {
    if (token.length === 0 || masked.length === 0) continue;
    let kept = "";
    let from = 0;
    for (;;) {
      const at = masked.indexOf(token, from);
      if (at < 0) break;
      const end = at + token.length;
      const joined =
        NAME_CHARACTER.test(masked[at - 1] ?? " ") ||
        NAME_CHARACTER.test(masked[end] ?? " ");
      kept += masked.slice(from, at) + (joined ? token : MASK);
      from = end;
    }
    masked = kept + masked.slice(from);
  }
  return masked;
}

function requiredNames(text: string): string[] {
  const names: string[] = [];
  for (const [issue] of text.matchAll(ISSUE_OBJECT)) {
    if (!ISSUE_SAYS_REQUIRED.test(issue)) continue;
    const path = ISSUE_PATH.exec(issue)?.[1];
    if (path === undefined) continue;
    const named = pathName(path);
    if (named !== undefined) names.push(named);
  }
  if (names.length > 0) return names;
  for (const [, flattened] of text.matchAll(FLATTENED_ISSUES)) {
    for (const [, name] of (flattened ?? "").matchAll(FLATTENED_REQUIRED)) {
      if (name !== undefined) names.push(name);
    }
  }
  for (const pattern of REQUIRED_PROSE) {
    for (const [, name] of text.matchAll(pattern)) {
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

function refusedNames(text: string): string[] {
  const names: string[] = [];
  for (const [, keys] of text.matchAll(UNRECOGNIZED_KEYS_ARRAY)) {
    names.push(...quotedNames(keys ?? ""));
  }
  for (const [, listed] of text.matchAll(UNRECOGNIZED_KEYS_PROSE)) {
    names.push(...quotedNames(listed ?? ""));
  }
  return names;
}

/**
 * The whole path, not its leaf: `value` alone appears all over the arguments. Shaped after joining,
 * so an index inside it survives.
 */
function pathName(path: string): string | undefined {
  const segments = [...path.matchAll(QUOTED_NAME)].map(([, segment]) =>
    (segment ?? "").trim(),
  );
  if (segments.length === 0) return undefined;
  const joined = segments.join(".");
  return NAME_SHAPE.test(joined) ? joined : undefined;
}

function quotedNames(fragment: string): string[] {
  return [...fragment.matchAll(QUOTED_NAME)]
    .map(([, name]) => (name ?? "").trim())
    .filter((name) => NAME_SHAPE.test(name));
}

// The names are provider-supplied text on their way into a message an author reads, so the set is
// deduplicated and bounded in both directions before it leaves here.
function boundedNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => safeName(name)))]
    .filter((name) => name !== "")
    .slice(0, REPORTED_NAME_LIMIT);
}

function safeName(name: string): string {
  return name.replace(CONTROL_CHARACTERS, " ").trim().slice(0, NAME_LENGTH_LIMIT);
}

function list(names: readonly string[]): string {
  return names.length === 1
    ? String(names[0])
    : `${names.slice(0, -1).join(", ")} and ${String(names[names.length - 1])}`;
}

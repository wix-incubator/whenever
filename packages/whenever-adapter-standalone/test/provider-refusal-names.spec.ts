import { describe, expect, it } from "vitest";

import {
  describeProviderInputRefusal,
  type ProviderInputRefusal,
  providerInputRefusalMessage,
} from "../src/provider-input-refusal";

const names = (
  error: unknown,
  sent: unknown = {},
): ProviderInputRefusal | undefined => describeProviderInputRefusal(error, sent);

const ZOD_REQUIRED = (path: string): string =>
  `MCP error -32602: Invalid arguments for tool run_sql: [{"code":"invalid_type","expected":"string","received":"undefined","path":[${path}],"message":"Required"}]`;

describe("what opens the gate on a provider's refusal", () => {
  it.each([
    "Input validation error: projectId is required",
    "Invalid arguments: projectId is required",
    "Invalid params: projectId is required",
    "required property: projectId is required",
    "required argument: projectId is required",
    "required parameter: projectId is required",
  ])("reads a refusal introduced by %s", (message) => {
    expect(names(message)).toEqual({ requires: ["projectId"], refused: [] });
  });

  // A bare validation code also fits a result that failed validation after a write landed, so it
  // is not enough on its own to call this a refusal of the input.
  it.each([
    ["a bare validation code", "invalid_type at projectId"],
    ["prose about something else", "the upstream service is unwell"],
    ["a phrase inside a longer word", "preinvalid_argumentsx: projectId"],
  ])("does not read %s as a refusal of the arguments", (_case, message) => {
    expect(names(message)).toBeUndefined();
  });

  it.each([
    ["a bare string", "Input validation error: projectId is required"],
    [
      "an error's message",
      new Error("Input validation error: projectId is required"),
    ],
  ])("reads the refusal out of %s", (_case, error) => {
    expect(names(error)).toEqual({ requires: ["projectId"], refused: [] });
  });

  it.each([
    ["a value with no message at all", { status: 400 }],
    ["a message that is not text", { message: 42 }],
    ["an empty message", ""],
    ["a message of only whitespace", "   \n  "],
    ["nothing", undefined],
  ])("reads no refusal out of %s", (_case, error) => {
    expect(names(error)).toBeUndefined();
  });

  // Bounded before anything walks it, so no pattern reads a longer string than it was measured on.
  it("reads no further into a refusal than its scan limit", () => {
    const filler = "z".repeat(8_000);

    expect(names(`${filler} Input validation error: projectId is required`)).toBeUndefined();
  });
});

describe("which argument names a refusal yields", () => {
  it("reads the path out of a structured issue that says the value was missing", () => {
    expect(names(ZOD_REQUIRED('"projectId"'))).toEqual({
      requires: ["projectId"],
      refused: [],
    });
  });

  // The whole path, not its leaf: `value` alone appears all over a set of arguments, so a leaf
  // would tell an author nothing about which one to fix.
  it("joins a nested path rather than reporting its leaf", () => {
    expect(names(ZOD_REQUIRED('"parent","child"'))).toEqual({
      requires: ["parent.child"],
      refused: [],
    });
  });

  it("keeps an index inside a path", () => {
    expect(names(ZOD_REQUIRED('"items","0","id"'))).toEqual({
      requires: ["items.0.id"],
      refused: [],
    });
  });

  it.each([
    ["a path segment carrying a space", '"not a name"'],
    ["an empty path", ""],
  ])("reports nothing for %s", (_case, path) => {
    expect(names(ZOD_REQUIRED(path))).toBeUndefined();
  });

  // Zod 3 said `"message":"Required"`, Zod 4 says `received undefined` in the message and the MCP
  // SDK has moved to 4, so both spellings have to be read.
  it.each([
    ['the zod 3 marker', '"message":"Required"'],
    ['the zod 3 received marker', '"received":"undefined"'],
    ["the zod 4 prose", '"message":"expected string, received undefined"'],
  ])("reads a missing value reported with %s", (_case, marker) => {
    const issue = `Invalid arguments for tool run_sql: [{"code":"invalid_type","path":["projectId"],${marker}}]`;

    expect(names(issue)).toEqual({ requires: ["projectId"], refused: [] });
  });

  // A path is only read as required when its own issue says so: the issue is matched whole, so a
  // neighbouring issue's message cannot vouch for this one's path.
  it("reads only the path of the issue that reported a missing value", () => {
    const issues =
      'Invalid arguments for tool run_sql: [{"code":"too_small","path":["sql"],"message":"Too short"},{"code":"invalid_type","path":["projectId"],"message":"Required"}]';

    expect(names(issues)).toEqual({ requires: ["projectId"], refused: [] });
  });

  it("reads the names a server flattened into prose", () => {
    const flattened =
      "MCP error -32602: Invalid arguments for tool run_sql: projectId Required, sql Required";

    expect(names(flattened)).toEqual({
      requires: ["projectId", "sql"],
      refused: [],
    });
  });

  it.each([
    ["a validator outside zod", "Input validation error: projectId is required"],
    [
      "a json schema validator",
      "Input validation error: 'projectId' is a required property",
    ],
    [
      "a server written outside typescript",
      "Invalid params: missing required argument: projectId",
    ],
  ])("reads the name %s named", (_case, message) => {
    expect(names(message)).toEqual({ requires: ["projectId"], refused: [] });
  });

  // A structured issue array is the provider's own machine reading of its schema, so it outranks
  // the prose beside it rather than being merged with it.
  it("prefers the structured issues over the prose beside them", () => {
    // The colon is what lets the prose reader see `sql` at all: without it the prose is never a
    // candidate and the precedence goes untested.
    const both = `${ZOD_REQUIRED('"projectId"')}: sql is required`;

    expect(names(both)).toEqual({ requires: ["projectId"], refused: [] });
  });

  it("reads the keys a structured refusal listed as unrecognized", () => {
    const issue =
      'Invalid arguments for tool run_sql: [{"code":"unrecognized_keys","keys":["projectId","extraThing"],"path":[]}]';

    expect(names(issue)).toEqual({
      requires: [],
      refused: ["projectId", "extraThing"],
    });
  });

  it("reads the keys a refusal listed in prose", () => {
    const prose =
      "Input validation error: Unrecognized key(s) in object: 'projectId', 'extraThing'";

    expect(names(prose)).toEqual({
      requires: [],
      refused: ["projectId", "extraThing"],
    });
  });

  // A `}` ends an issue. Reading past one would report a later object's keys as this issue's, and
  // so name an argument the provider never refused.
  it("does not read a later issue's keys as this one's", () => {
    const issues =
      'Invalid arguments: [{"code":"unrecognized_keys","path":[]},{"code":"other","keys":["neverRefused"]}]';

    // Nothing at all: the first issue named no keys and the second one's are not its to report.
    expect(names(issues)).toBeUndefined();
  });

  it("reports both what a refusal refused and what it required", () => {
    const both =
      'Invalid arguments for tool run_sql: [{"code":"invalid_type","path":["projectId"],"message":"Required"},{"code":"unrecognized_keys","keys":["extraThing"],"path":[]}]';

    expect(names(both)).toEqual({
      requires: ["projectId"],
      refused: ["extraThing"],
    });
  });
});

describe("what a refusal about something else cannot become", () => {
  it.each([
    "output validation",
    "result validation",
    "response validation",
    "parse the response",
    "authentication",
    "authorization",
    "unauthorized",
    "forbidden",
    "permission",
  ])("throws away a refusal that also complains about %s", (complaint) => {
    expect(names(`Input validation error: projectId is required (${complaint})`)).toBeUndefined();
  });

  // The names are blanked before the exclusion runs, because they sit in the same text. An
  // argument named exactly `permission` read as a complaint about permissions and was discarded.
  it("keeps a refusal whose refused argument is itself named permission", () => {
    const issue =
      'Invalid arguments for tool grant: [{"code":"unrecognized_keys","keys":["permission"],"path":[]}]';

    expect(names(issue)).toEqual({ requires: [], refused: ["permission"] });
  });

  // Matched at the edges of a word rather than anywhere inside one, or every argument whose name
  // contains a complaint word would throw its own refusal away.
  it("keeps a refusal naming an argument whose name contains a complaint word", () => {
    const issue =
      'Invalid arguments for tool grant: [{"code":"unrecognized_keys","keys":["permission_level"],"path":[]}]';

    expect(names(issue)).toEqual({ requires: [], refused: ["permission_level"] });
  });

  // The tool's own name is text the blanking never reaches, so a complaint word inside it is what
  // the edges have to hold against.
  it("keeps a refusal whose tool name contains a complaint word", () => {
    const issue =
      "MCP error -32602: Invalid arguments for tool grant_permission_level: projectId Required";

    expect(names(issue)).toEqual({ requires: ["projectId"], refused: [] });
  });

  // The prose reader excludes these itself, so "authentication is required" never becomes an
  // argument named `authentication`.
  it.each(["authentication", "authorization", "permission", "approval"])(
    "does not read %s is required as an argument name",
    (word) => {
      expect(names(`Input validation error: ${word} is required`)).toBeUndefined();
    },
  );
});

describe("what a value the call sent cannot do to the names", () => {
  // Gated on the provider's own words and read from the masked copy: an echo of what was sent can
  // open the gate but must never supply a name, or a workflow could forge one.
  it("does not let an echo of a sent value forge an argument name", () => {
    const sent = { note: "projectId is required" };
    const echo = "Input validation error: projectId is required";

    expect(names(echo, sent)).toBeUndefined();
  });

  it("does not let a sent value suppress the marker and hide a real refusal", () => {
    // The issue array carries no marker phrase of its own, so the marker here comes from the
    // echo. Masking before the gate would erase it and lose the name the provider did report.
    const issues =
      'Input validation error [{"code":"invalid_type","path":["projectId"],"message":"Required"}]';

    expect(names(issues, { note: "Input validation error" })).toEqual({
      requires: ["projectId"],
      refused: [],
    });
  });

  it("does not let an echoed issue array forge a name", () => {
    const forged = ZOD_REQUIRED('"forgedName"');

    expect(names(forged, { note: forged })).toBeUndefined();
  });

  // A substring replacement ate the name it was meant to protect: a sent value of `user` turned a
  // refusal naming `userId` into `[sent]Id`.
  it("masks a sent value only where it stands alone", () => {
    expect(
      names("Input validation error: userId is required", { role: "user" }),
    ).toEqual({ requires: ["userId"], refused: [] });
  });

  // Values only, never keys: a key is the name this is trying to report.
  it("never masks a name because the call used it as a key", () => {
    expect(
      names("Input validation error: projectId is required", {
        projectId: "abcdef",
      }),
    ).toEqual({ requires: ["projectId"], refused: [] });
  });

  it("reads past a sent value too short to be worth masking", () => {
    expect(
      names("Input validation error: ab is required", { value: "ab" }),
    ).toEqual({ requires: ["ab"], refused: [] });
  });

  it("collects a sent value out of an array", () => {
    const sent = { notes: ["projectId is required"] };

    expect(names("Input validation error: projectId is required", sent)).toBeUndefined();
  });

  // The walk is bounded, so a value buried past the depth it reads cannot mask anything — which
  // is why the gate runs on the provider's own words rather than on what is left after masking.
  it("does not reach a sent value buried past the depth it walks", () => {
    let sent: unknown = "projectId is required";
    for (let depth = 0; depth < 8; depth += 1) sent = { nested: sent };

    expect(names("Input validation error: projectId is required", sent)).toEqual({
      requires: ["projectId"],
      refused: [],
    });
  });
});

describe("the bounds on what a refusal reports", () => {
  const requiredList = (count: number): string =>
    `Invalid arguments for tool run_sql: [${Array.from(
      { length: count },
      (_unused, index) =>
        `{"code":"invalid_type","path":["field${String(index)}"],"message":"Required"}`,
    ).join(",")}]`;

  it("reports no more names than the limit allows", () => {
    expect(names(requiredList(9))?.requires).toEqual([
      "field0",
      "field1",
      "field2",
      "field3",
      "field4",
    ]);
  });

  it("reports a name the provider repeated only once", () => {
    const repeated =
      'Invalid arguments for tool run_sql: [{"code":"invalid_type","path":["projectId"],"message":"Required"},{"code":"invalid_type","path":["projectId"],"message":"Required"}]';

    expect(names(repeated)?.requires).toEqual(["projectId"]);
  });

  // Through a structured path, because every prose pattern bounds its own capture below the cap:
  // a path segment is read up to 200 characters and its shape check has no length of its own.
  it("bounds the length of a single name", () => {
    const long = `a${"b".repeat(80)}`;
    const reported = names(ZOD_REQUIRED(`"${long}"`));

    expect(reported?.requires[0]).toHaveLength(60);
  });

  // Stronger than stripping it: a quoted key carrying a control character fails the name shape
  // check and is never reported. The stripping is reachable only through the operation id, which
  // the sentence tests below cover.
  it("reports no name at all when a provider put a control character in one", () => {
    const issue =
      'Invalid arguments: Unrecognized key(s) in object: "pro\u0000jectId"';

    expect(names(issue)).toBeUndefined();
  });
});

describe("the sentence an author is shown", () => {
  const message = (
    refusal: ProviderInputRefusal,
    repair = "Send the names the provider asks for.",
  ): string => providerInputRefusalMessage("mcp.read", refusal, repair);

  it("names the refused argument before the required one, because it is the one to remove", () => {
    expect(message({ requires: ["projectId"], refused: ["extraThing"] })).toBe(
      "mcp.read was refused over its argument names: the provider does not accept extraThing and it requires projectId. Send the names the provider asks for.",
    );
  });

  it.each([
    [["one"], "one"],
    [["one", "two"], "one and two"],
    [["one", "two", "three"], "one, two and three"],
  ])("joins %s as a list an author can read", (refused, joined) => {
    expect(message({ requires: [], refused })).toContain(
      `does not accept ${joined}.`,
    );
  });

  it("says only that the arguments were refused when it has no names", () => {
    expect(message({ requires: [], refused: [] })).toBe(
      "mcp.read was refused over its arguments. Send the names the provider asks for.",
    );
  });

  // Composed to fit rather than trimmed to fit: trimming a finished sentence is what cut it off
  // mid-word before, so names come off the end until the whole sentence fits.
  it("drops names rather than cutting the sentence short", () => {
    const many = Array.from({ length: 5 }, (_unused, index) => `field${String(index)}${"x".repeat(50)}`);
    const composed = message({ requires: [], refused: many });

    expect(composed.length).toBeLessThanOrEqual(300);
    expect(composed).toMatch(/\.$/u);
    // Fewer names, still a sentence about names: dropping all of them would leave an author with
    // nothing to change.
    expect(composed).toContain("does not accept field0");
  });

  // The advice is the caller's verbatim and the last thing to go, because a sentence with no
  // advice still says what to change.
  it("drops the advice before it reports a sentence that does not fit", () => {
    const composed = message({
      requires: [],
      refused: [`field${"x".repeat(280)}`],
    });

    expect(composed.length).toBeLessThanOrEqual(300);
    expect(composed).not.toContain("Send the names");
    expect(composed).toContain("mcp.read was refused over its argument names");
    expect(composed).toContain("does not accept field");
  });

  it("reports an operation id with its control character turned into a space", () => {
    const composed = providerInputRefusalMessage(
      "mcp\u0000.read",
      { requires: [], refused: [] },
      "",
    );

    // The whole sentence, which fails for a control character anywhere in it and for an id that
    // never arrived. A separate not.toContain could not fail independently of this.
    expect(composed).toBe("mcp .read was refused over its arguments.");
  });
});

import { describe, expect, it } from "vitest";

import {
  describeProviderInputRefusal,
  providerInputRefusalMessage,
} from "../src/provider-input-refusal";

// Argument names can arrive in a JSON array embedded in prose.
const NEON_REFUSAL =
  'MCP tool error: MCP error -32602: Input validation error: Invalid arguments for tool run_sql: [\n' +
  '  {\n    "code": "invalid_type",\n    "expected": "string",\n    "received": "undefined",\n' +
  '    "path": [\n      "project_id"\n    ],\n    "message": "Required"\n  },\n' +
  '  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "projectId"\n    ],\n' +
  '    "path": [],\n    "message": "Unrecognized key(s) in object: \'projectId\'"\n  }\n]';

// The longest closing sentence either caller passes, so every cap here measures the worst case.
/** These tests describe a refusal of a call that sent no argument value worth masking. */
const SENT_NOTHING = {};

const REPAIR =
  "Send the names the provider asks for; the declaration this operation was given disagrees with " +
  "its own answer.";

describe("describeProviderInputRefusal", () => {
  it.each([
    "org_id is required, you can find it on your organization settings page",
    '{"request_id":"request-1","code":"","message":"org_id is required, you can find it on your organization settings page"}',
  ])("recognizes Neon's missing organization input: %s", (message) => {
    expect(describeProviderInputRefusal(message, {})).toEqual({
      requires: ["org_id"], refused: [],
    });
  });

  it("does not classify an echoed required-field sentence as a provider refusal", () => {
    const message = "org_id is required";
    expect(describeProviderInputRefusal(message, { text: message })).toBeUndefined();
  });

  it("names both the argument the provider requires and the one it refused", () => {
    expect(describeProviderInputRefusal(NEON_REFUSAL, SENT_NOTHING)).toEqual({
      requires: ["project_id"],
      refused: ["projectId"],
    });
  });

  it("answers nothing for a refusal that names no argument, so the provider's own words stand", () => {
    expect(describeProviderInputRefusal("Table not found", SENT_NOTHING)).toBeUndefined();
    expect(describeProviderInputRefusal("permission denied", SENT_NOTHING)).toBeUndefined();
  });

  it("answers nothing for a validation error that names no key at all", () => {
    expect(
      describeProviderInputRefusal("Input validation error: the request is malformed", SENT_NOTHING),
    ).toBeUndefined();
  });

  it("leads with the names, so a detail cap cannot cut the diagnosis off", () => {
    const message = providerInputRefusalMessage(
      "neon_mcp.runSql",
      { requires: ["project_id"], refused: ["projectId"] },
      REPAIR,
    );
    expect(message.slice(0, 120)).toContain("project_id");
    expect(message.slice(0, 120)).toContain("projectId");
  });
});


describe('what survives the readers downstream', () => {
  const message = providerInputRefusalMessage(
    'neon_mcp.runSql',
    { requires: ['project_id'], refused: ['projectId'] },
    REPAIR,
  );

  // ASCII-only consumers replace non-ASCII characters with spaces and collapse runs of
  // whitespace, so a clause break carried by punctuation it strips is a clause break that is lost.
  it('reads the same after a reader strips it to ASCII', () => {
    const stripped = message.replace(/[^\x20-\x7e]/gu, ' ').replace(/\s+/gu, ' ').trim();

    expect(stripped).toBe(message);
  });

  it('fits inside the tightest detail cap it passes through', () => {
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('names both what to remove and what to send', () => {
    expect(message).toContain('does not accept projectId');
    expect(message).toContain('requires project_id');
  });
});

describe("reading a name the provider actually refused", () => {
  // The prose reader is anchored to that one phrase, so a sentence that merely uses the word
  // cannot contribute a name — an English word beside it would read as the field to send.
  it("reads no name out of prose that only mentions being required", () => {
    expect(
      describeProviderInputRefusal(
        "Invalid params: the sql argument is Required for this tool",
        SENT_NOTHING,
      ),
    ).toBeUndefined();
  });

  it("prefers the issue array over the prose when the provider sends both", () => {
    const refusal = describeProviderInputRefusal(
      "Input validation error: Invalid arguments for tool run_sql: " +
        '[{"path":["project_id"],"message":"Required"}] also branch_id Required',
      SENT_NOTHING,
    );

    expect(refusal?.requires).toEqual(["project_id"]);
  });
});

describe("reading text a provider controls", () => {
  // Every fixture opens with a marker and ends in a character `trim` keeps, or it never reaches
  // the patterns: two of these returned at the gate, passing against an 87-second scanner.
  const adversarial: Record<string, string> = {
    "unclosed issue objects": `Input validation error: ${'{"path": ['.repeat(400)}x`,
    "a long run of quotes": `Input validation error: ${'"'.repeat(7_900)}x`,
    "many complete issues": `Input validation error: ${'{"path":["a"],"message":"Required"},'.repeat(400)}x`,
    "a flood of open braces": `Input validation error: unrecognized_keys ${"{".repeat(7_900)}x`,
    "a path behind filler": `invalid arguments {${"x".repeat(7_000)}"path": ["p"]x`,
    // Ambiguous whitespace matches must remain bounded even when the final character survives trim.
    "filler behind the prose marker": `Input validation error: unrecognized key${" ".repeat(7_900)}x`,
    "filler behind the array marker": `Input validation error: "unrecognized_keys"${" ".repeat(7_900)}x`,
    "filler behind a required marker": `invalid arguments for tool t:${" ".repeat(7_900)}x`,
    "quoted filler behind a key list": `Input validation error: unrecognized key(s) in object: ${"'a', ".repeat(1_500)}x`,
  };

  it("clears the marker gate for every shape below, or they measure nothing", () => {
    for (const text of Object.values(adversarial)) {
      // A shape that answers before a pattern runs cannot report on that pattern's cost.
      expect(text.length).toBeGreaterThan(1_000);
      expect(/input validation error|invalid arguments|unrecognized/iu.test(text)).toBe(true);
    }
  });

  for (const [shape, text] of Object.entries(adversarial)) {
    it(`answers ${shape} promptly`, () => {
      const startedAt = performance.now();
      describeProviderInputRefusal(text, SENT_NOTHING);

      expect(performance.now() - startedAt).toBeLessThan(250);
    });
  }

  it("reads no argument name out of a refusal about the world", () => {
    for (const refusal of [
      "invalid_auth: the token was revoked",
      "channel_not_found",
      "missing_scope: chat:write",
      "RESOURCE_EXHAUSTED",
    ]) {
      expect(describeProviderInputRefusal(refusal, SENT_NOTHING)).toBeUndefined();
    }
  });

  // Refused rather than cleaned up: a name is only worth reporting if an author could type it.
  it("reports no name that is not shaped like one", () => {
    for (const name of [
      "pro\u0007jectId",
      "Bearer sk-live-000",
      "https://mcp.neon.tech/mcp",
      "1projectId",
    ]) {
      expect(
        describeProviderInputRefusal(
          `Input validation error: Unrecognized key(s) in object: '${name}'`,
          SENT_NOTHING,
        ),
      ).toBeUndefined();
    }
  });
});

describe("what counts as a complaint about the request", () => {
  // Both carry a marker naming the input, so the exclusion is what has to answer: a text failing
  // the first gate would be refused whether the exclusion existed or not.
  it("reads nothing out of a validation failure about the result", () => {
    expect(
      describeProviderInputRefusal(
        'Invalid arguments returned by the tool. Output validation error: {"code":"invalid_type","received":"undefined","path":["createdId"],"message":"Required"}',
        SENT_NOTHING,
      ),
    ).toBeUndefined();
  });

  it("reads nothing out of an authorization failure that quotes a field", () => {
    expect(
      describeProviderInputRefusal(
        'Invalid params: authentication failed for {"code":"invalid_type","received":"undefined","path":["apiKey"],"message":"Required"}',
        SENT_NOTHING,
      ),
    ).toBeUndefined();
  });

  // The names are in the same text as the complaint, so a substring search over it throws away a
  // refusal of a field that merely reads like one. Every field here names a real argument.
  it("still reads a refusal whose field name contains a word it excludes", () => {
    for (const name of [
      "permission_level",
      "permissions",
      "authorization_id",
      "authType",
      "forbidden_terms",
    ]) {
      expect(
        describeProviderInputRefusal(
          `Input validation error: Unrecognized key(s) in object: '${name}'`,
          SENT_NOTHING,
        ),
      ).toEqual({ requires: [], refused: [name] });
    }
  });

  it("reads a lower-cased refusal the same as a capitalised one", () => {
    expect(
      describeProviderInputRefusal(
        `input validation error: unrecognized key(s) in object: "projectId"`,
        SENT_NOTHING,
      ),
    ).toEqual({ requires: [], refused: ["projectId"] });
  });

  it("keeps the refused name inside the cap however many names the provider lists", () => {
    const long = (at: number) => `${"f".repeat(58)}${String(at)}`;
    const issues = Array.from(
      { length: 5 },
      (_, at) => `{"path":["${long(at)}"],"message":"Required"}`,
    ).join(",");
    const refusal = describeProviderInputRefusal(
      `Input validation error: Invalid arguments for tool t: [${issues},{"code":"unrecognized_keys","keys":["projectId"]}]`,
      SENT_NOTHING,
    );

    expect(refusal?.refused).toContain("projectId");
    const message = providerInputRefusalMessage(
      "neon_mcp.runSql",
      refusal ?? { requires: [], refused: [] },
      REPAIR,
    );
    expect(message.length).toBeLessThanOrEqual(300);
    expect(message.slice(0, 300)).toContain("projectId");
  });
});


describe("a sent value that reads as part of a name the provider refused", () => {
  it("still reports a refused name the value is only a prefix of", () => {
    expect(
      describeProviderInputRefusal(
        'Input validation error: [{"code":"unrecognized_keys","keys":["userId"]}]',
        { table: "user" },
      )?.refused,
    ).toEqual(["userId"]);
  });

  it("still reports a required name the value is only a prefix of", () => {
    expect(
      describeProviderInputRefusal(
        'Invalid arguments for tool t: [{"received":"undefined","path":["projectId"]}]',
        { note: "project" },
      )?.requires,
    ).toEqual(["projectId"]);
  });

  it("still reads the refusal when a sent value spells its only marker", () => {
    expect(
      describeProviderInputRefusal(
        'Invalid params: [{"received":"undefined","path":["projectId"]}]',
        { mode: "Invalid params" },
      )?.requires,
    ).toEqual(["projectId"]);
  });
});

describe("an argument whose own name is a word this reads as another complaint", () => {
  it("reports an argument named exactly authorization", () => {
    expect(
      describeProviderInputRefusal(
        'Invalid arguments for tool t: [{"received":"undefined","path":["authorization"]}]',
        SENT_NOTHING,
      )?.requires,
    ).toEqual(["authorization"]);
  });

  it("still throws away a refusal that is really about permissions", () => {
    expect(
      describeProviderInputRefusal(
        'Input validation error: the caller lacks permission for this tool: [{"code":"unrecognized_keys","keys":["projectId"]}]',
        SENT_NOTHING,
      ),
    ).toBeUndefined();
  });

  it("still throws away a result that failed validation after the tool ran", () => {
    expect(
      describeProviderInputRefusal(
        'Output validation error: missing required property "id"',
        SENT_NOTHING,
      ),
    ).toBeUndefined();
  });
});

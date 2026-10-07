import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const EXAMPLE = readFileSync("examples/canonical.workflow.ts", "utf8");

describe("the canonical workflow example", () => {
  it("declares a schedule, so it must not read ctx.input", () => {
    expect(EXAMPLE).toContain("daily(");
    expect(EXAMPLE).not.toContain("ctx.input");
  });

  it("narrows an unknown http body with a guard, never an assertion", () => {
    expect(EXAMPLE).toContain("ctx.integrations.http.get(");
    expect(EXAMPLE).toContain("body is {");
    expect(EXAMPLE).not.toMatch(/\.body as /u);
    expect(EXAMPLE).toContain("NonRetryableError");
  });

  it("demonstrates an mcp tool call, so mcp is not the one built-in shown only in prose", () => {
    expect(EXAMPLE).toContain("ctx.integrations.mcp.read(");
    expect(EXAMPLE).toContain("toolName:");
    expect(EXAMPLE).toContain("toolProps:");
    expect(EXAMPLE).not.toMatch(/structuredContent as /u);
    // Measured against Neon's hosted server: 0 of its 104 tools declare an output schema, so
    // structuredContent is absent and an example that reads only that field teaches a call which
    // succeeds and then throws. The text block of content is the half that is always populated.
    expect(EXAMPLE).toContain("structuredContent");
    expect(EXAMPLE).toContain(".content");
    expect(EXAMPLE).toMatch(/JSON\.parse/u);
    // The prompt requires an mcp address and header to come from ctx.secrets; an inlined one
    // here outvoted that rule in every run of the arm that measured it.
    expect(EXAMPLE).toContain("url: ctx.secrets.AUDIT_MCP_URL");
    expect(EXAMPLE).toContain("headers: { Authorization:");
  });

  it("carries what it saw on every throw", () => {
    // Read each throw's own text: a detail: anywhere else would mask a bare one.
    const statements = EXAMPLE.split("throw new ")
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf("});")));

    expect(statements.length).toBeGreaterThan(3);
    for (const statement of statements) {
      expect(statement).toContain("detail: shapeOf(");
    }
  });

  it("marks its substituted identifiers as supplied, not invented", () => {
    const constants = EXAMPLE.match(/^const \w+ = "[^"]+";$/gmu) ?? [];
    expect(constants.length).toBeGreaterThan(0);
    expect(EXAMPLE).toMatch(/Supplied by the user, not invented/u);
  });
});

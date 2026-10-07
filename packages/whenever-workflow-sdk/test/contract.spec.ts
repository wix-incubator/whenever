import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { WORKFLOW_SDK_CONTRACT } from "../dist/contract.js";
import * as sdk from "../src/index";

const distIndexDts = readFileSync("dist/index.d.ts", "utf8");
const distIntegrationsDts = readFileSync("dist/integrations.d.ts", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};

function parseDeclaredNames(declaration: string): string[] {
  const names = new Set<string>();
  const pattern = /export\s+(?:declare\s+)?(?:interface|type|const|function|class)\s+([A-Za-z0-9_$]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(declaration)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

function parseExportedNames(declaration: string): string[] {
  const names = new Set<string>();
  const pattern = /export\s+(?:type\s+)?\{([^}]*)\}\s*from/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(declaration)) !== null) {
    for (const entry of match[1].split(",")) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

function unwrapJsDoc(markdown: string): string {
  return markdown.replace(/\n\s*\*\s?/g, " ");
}

describe("WORKFLOW_SDK_CONTRACT", () => {
  const prose = unwrapJsDoc(WORKFLOW_SDK_CONTRACT.markdown);
  const integrationProse = unwrapJsDoc(
    WORKFLOW_SDK_CONTRACT.integrationDeclarations,
  );

  it("reports the SDK package version", () => {
    expect(WORKFLOW_SDK_CONTRACT.version).toBe(packageJson.version);
  });

  it("lists every public export parsed from the emitted index.d.ts", () => {
    const exported = parseExportedNames(distIndexDts);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(WORKFLOW_SDK_CONTRACT.symbols).toContain(name);
    }
  });

  it("lists every runtime value export of the SDK", () => {
    const valueExports = Object.keys(sdk);
    expect(valueExports.length).toBeGreaterThan(0);
    for (const name of valueExports) {
      expect(WORKFLOW_SDK_CONTRACT.symbols).toContain(name);
    }
  });

  it("names the integrations surface from what the integrations module actually declares", () => {
    const declared = parseDeclaredNames(distIntegrationsDts);
    expect(declared.length).toBeGreaterThan(0);
    expect([...WORKFLOW_SDK_CONTRACT.integrationSymbols].sort()).toEqual(
      declared.sort(),
    );
  });

  it("declares the built-in namespaces, so a binding can claim any other", () => {
    const members = /export interface WorkflowIntegrations \{([^}]*)\}/u.exec(
      distIntegrationsDts,
    );
    expect(members).not.toBeNull();
    expect(
      [...members![1].matchAll(/^\s*(\w+)\s*:/gmu)].map((match) => match[1]),
    ).toEqual(["ai", "http", "mcp", "postgres"]);
  });

  it("renders every core symbol into the declarations and markdown", () => {
    const integrationSymbols = new Set(WORKFLOW_SDK_CONTRACT.integrationSymbols);
    const core = WORKFLOW_SDK_CONTRACT.symbols.filter(
      (symbol) => !integrationSymbols.has(symbol),
    );
    expect(core.length).toBeGreaterThan(0);
    for (const symbol of core) {
      expect(WORKFLOW_SDK_CONTRACT.declarations).toContain(symbol);
      expect(WORKFLOW_SDK_CONTRACT.markdown).toContain(symbol);
    }
  });

  it("renders every integration symbol into the separately served integrations surface", () => {
    expect(WORKFLOW_SDK_CONTRACT.integrationSymbols.length).toBeGreaterThan(0);
    for (const symbol of WORKFLOW_SDK_CONTRACT.integrationSymbols) {
      expect(WORKFLOW_SDK_CONTRACT.integrationDeclarations).toContain(symbol);
    }
  });

  it("keeps per-operation integration types out of the inlined authoring surface", () => {
    const perOperation = ["HttpRequestInput", "HttpWriteInput"];
    for (const symbol of perOperation) {
      expect(WORKFLOW_SDK_CONTRACT.integrationSymbols).toContain(symbol);
      expect(WORKFLOW_SDK_CONTRACT.declarations).not.toContain(symbol);
      expect(WORKFLOW_SDK_CONTRACT.markdown).not.toContain(symbol);
    }
  });

  it("tells an author that ctx.integrations exists and that a binding declares the rest", () => {
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("ctx.integrations");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("WorkflowIntegrations");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("http");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("comes from a binding");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain(
      "neither typechecks nor runs",
    );
  });

  it("names no provider the SDK no longer declares", () => {
    for (const gone of [
      "GoogleIntegration",
      "SlackIntegration",
      "StripeIntegration",
      "ctx.integrations.slack",
      "ctx.integrations.google",
    ]) {
      expect(WORKFLOW_SDK_CONTRACT.markdown).not.toContain(gone);
      expect(WORKFLOW_SDK_CONTRACT.declarations).not.toContain(gone);
    }
  });

  it("preserves the http evidence boundary in published declarations", () => {
    expect(integrationProse).toContain(
      "uncertainty is never automatically retried",
    );
  });

  it("serves the integrations surface separately from the inlined authoring surface", () => {
    expect(WORKFLOW_SDK_CONTRACT.integrationDeclarations).toContain(
      "HttpIntegration",
    );
    expect(WORKFLOW_SDK_CONTRACT.markdown).not.toContain(
      WORKFLOW_SDK_CONTRACT.integrationDeclarations,
    );
  });

  it("documents plain webhooks and the host's verification responsibility", () => {
    expect(prose).toContain("Declares an unverified inbound HTTP webhook");
    expect(prose).toContain("`@wix/whenever-workflow-sdk/webhooks`");
    expect(prose).toContain("host must verify those with the sender's credentials");
  });

  it("explains webhook descriptor key semantics", () => {
    expect(prose).toContain("changing it issues a different URL");
    expect(prose).toContain("display text and is never used as endpoint identity");
    expect(prose).toContain("Throws when `key` is empty");
  });

  it("states the time-of-day format and granularity the schedule sugar accepts", () => {
    expect(prose).toContain('"HH:MM" on a 24-hour clock');
    expect(prose).toContain("seconds are not accepted");
  });

  it("states that once takes an absolute instant, not a time of day", () => {
    expect(prose).toContain("absolute ISO 8601 instant");
    expect(prose).toContain("2026-08-01T09:00:00Z");
    expect(prose).toContain("not a time of day");
  });

  it("documents the workflow module shape and the canonical example", () => {
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("manifest");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("defineWorkflow");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("WorkflowManifest");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("daily-rate-report");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("ctx.log");
  });

  it("states the outcome invariant a run's success is proven from", () => {
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain("Outcome:");
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain(
      "return a value that names what the workflow did",
    );
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain(
      "A workflow that returns nothing cannot be proven to have succeeded",
    );
  });

  it("leaves outcome recording and trigger activation to the host", () => {
    expect(WORKFLOW_SDK_CONTRACT.markdown).not.toContain(
      "records the run as failed",
    );
    expect(WORKFLOW_SDK_CONTRACT.markdown).toContain(
      "The host defines how it records outcomes and activates triggers",
    );
  });
});

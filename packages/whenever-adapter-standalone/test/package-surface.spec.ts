import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import * as adapters from "../src/index";

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
) as {
  dependencies: Record<string, string>;
  exports: Record<string, unknown>;
};

describe("the adapters package", () => {
  it("depends only on the SDK and a portable HTTP transport", () => {
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@wix/whenever-workflow-sdk",
      "undici",
    ]);
  });

  it("gives a workflow host everything it needs to build ctx.integrations", () => {
    expect(adapters.createWorkflowIntegrationsFromEnv({})).toMatchObject({
      ai: expect.any(Object) as unknown,
      http: expect.any(Object) as unknown,
      mcp: expect.any(Object) as unknown,
      postgres: expect.any(Object) as unknown,
    });
  });

  it("keeps transport helpers off the public entry point", () => {
    expect(Object.keys(manifest.exports)).toContain("./internal");
    expect(Object.keys(adapters)).toEqual(
      expect.not.arrayContaining([
        "requestJson",
        "strictJsonSnapshot",
        "prepareHttpGetInput",
      ]),
    );
  });
});

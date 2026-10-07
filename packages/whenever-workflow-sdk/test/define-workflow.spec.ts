import { describe, expect, it, vi } from "vitest";

import { defineWorkflow, isWorkflowDefinition } from "../src/define-workflow";

describe("defineWorkflow", () => {
  it("carries run onto the definition and preserves its identity", () => {
    const run = vi.fn(async () => {});

    const wf = defineWorkflow(run);

    expect(wf.brand).toBe("@wix/whenever-workflow-sdk/workflow");
    expect(wf.run).toBe(run);
  });

  it("returns a frozen, immutable definition", () => {
    const wf = defineWorkflow(async () => {});

    expect(Object.isFrozen(wf)).toBe(true);
  });
});

describe("isWorkflowDefinition", () => {
  it("accepts a defineWorkflow result", () => {
    const wf = defineWorkflow(async () => {});

    expect(isWorkflowDefinition(wf)).toBe(true);
  });

  it("rejects plain objects, null, and strings", () => {
    expect(isWorkflowDefinition({ name: "wf", triggers: [] })).toBe(false);
    expect(isWorkflowDefinition({ brand: "something-else" })).toBe(false);
    expect(isWorkflowDefinition(null)).toBe(false);
    expect(isWorkflowDefinition("workflow")).toBe(false);
  });
});

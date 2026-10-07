import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowContext,
  defineStep,
  isWorkflowStep,
  type WorkflowContext,
  type WorkflowIntegrations,
} from "../src/index";

function fakeIntegrations(): WorkflowIntegrations {
  return {
    ai: { generateImage: vi.fn(), generateText: vi.fn() },
    http: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() },
    mcp: { read: vi.fn(), write: vi.fn() },
    postgres: { query: vi.fn() },
  };
}

describe("defineStep", () => {
  it("uses a global non-enumerable symbol to identify workflow steps", () => {
    const step = defineStep("Read", async () => 1);
    const marker = Symbol.for("@wix/whenever-workflow-sdk/step");

    expect(isWorkflowStep(step)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(step, marker),
    ).toEqual({
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    expect((step as unknown as { brand?: unknown }).brand).toBeUndefined();
    expect(step.stepName).toBe("Read");
  });

  it("routes a callable step through the runtime executor", async () => {
    const executeStep = vi.fn(async (_name, operation) => await operation());
    const context = createWorkflowContext({
      input: { offset: 3 },
      trigger: { type: "manual", key: "run" },
      step: executeStep,
      log: vi.fn(),
      now: () => 1,
      random: () => 0,
      integrations: fakeIntegrations(),
    });
    const addOffset = defineStep(
      "Add offset",
      (ctx: WorkflowContext<{ offset: number }>, value: number) =>
        ctx.input.offset + value,
    );

    await expect(addOffset(context, 4)).resolves.toBe(7);
    expect(executeStep).toHaveBeenCalledWith("Add offset", expect.any(Function));
  });

  it("rejects an empty display name", () => {
    expect(() => defineStep("  ", async () => undefined)).toThrow(
      "defineStep name must not be empty",
    );
  });

  it("fails closed outside a runtime-created context", async () => {
    const step = defineStep("Read", async () => 1);

    await expect(step({} as WorkflowContext)).rejects.toThrow(
      "defineStep can only run with a runtime-created WorkflowContext",
    );
  });
});

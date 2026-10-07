import { describe, expect, it, vi } from "vitest";

import {
  createWorkflowContext,
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

describe("createWorkflowContext", () => {
  it("exposes an immutable null-prototype workflow-secret view", () => {
    const context = createWorkflowContext({
      input: undefined,
      secrets: { SLACK_CHANNEL_ID: "C123" },
      trigger: { type: "manual", key: "run" },
      step: async (_name, operation) => operation(),
      log: vi.fn(),
      now: () => 1,
      random: () => 0,
      integrations: fakeIntegrations(),
    });

    expect(context.secrets.SLACK_CHANNEL_ID).toBe("C123");
    expect(Object.getPrototypeOf(context.secrets)).toBeNull();
    expect(Object.isFrozen(context.secrets)).toBe(true);
    expect(() => {
      (context.secrets as Record<string, string>).SLACK_CHANNEL_ID = "changed";
    }).toThrow();
  });

  it("exposes an immutable null-prototype workflow-config view", () => {
    const context = createWorkflowContext({
      input: undefined,
      config: { SLACK_CHANNEL_ID: "C123" },
      trigger: { type: "manual", key: "run" },
      step: async (_name, operation) => operation(),
      log: vi.fn(),
      now: () => 1,
      random: () => 0,
      integrations: fakeIntegrations(),
    });

    expect(context.config.SLACK_CHANNEL_ID).toBe("C123");
    expect(Object.getPrototypeOf(context.config)).toBeNull();
    expect(Object.isFrozen(context.config)).toBe(true);
    expect(() => {
      (context.config as Record<string, string>).SLACK_CHANNEL_ID = "changed";
    }).toThrow();
  });

  it("attaches runtime-supplied integration ports without constructing adapters", () => {
    const integrations = fakeIntegrations();

    const context = createWorkflowContext({
      input: { workflowId: "workflow-1" },
      trigger: { type: "manual", key: "run" },
      step: async (_name, operation) => operation(),
      log: vi.fn(),
      now: () => 123,
      random: () => 0.5,
      integrations,
    });

    expect(context.input).toEqual({ workflowId: "workflow-1" });
    expect(context.integrations).toBe(integrations);
  });

  it("exposes the trigger that started the run as ctx.trigger", () => {
    const trigger = {
      type: "schedule",
      key: "morning",
      cron: "0 9 * * *",
      expectedAt: 1_767_258_000_000,
    } as const;

    const context = createWorkflowContext({
      input: undefined,
      trigger,
      step: async (_name, operation) => operation(),
      log: vi.fn(),
      now: () => 1,
      random: () => 0,
      integrations: fakeIntegrations(),
    });

    expect(context.trigger).toEqual(trigger);
  });

  it("forwards ctx.log to the runtime-supplied sink", () => {
    const log = vi.fn();
    const integrations = fakeIntegrations();

    const context = createWorkflowContext({
      input: undefined,
      trigger: { type: "manual", key: "run" },
      step: async (_name, operation) => operation(),
      log,
      now: () => 1,
      random: () => 0,
      integrations,
    });

    context.log("analyzing emails", { count: 3 });

    expect(log).toHaveBeenCalledWith("analyzing emails", { count: 3 });
  });
});

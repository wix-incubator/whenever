import { describe, expect, it, vi } from "vitest";

import { bindOperations, runWorkflow, type WorkflowAdapter } from "../src/host";
import {
  defineStep,
  defineWorkflow,
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

const manual = { type: "manual", key: "run" } as const;

describe("runWorkflow", () => {
  it("returns what the workflow returns, given the run's input, trigger, config and secrets", async () => {
    const workflow = defineWorkflow<{ name: string }, string>(async (ctx) =>
      `${ctx.input.name} via ${ctx.trigger.key} in ${ctx.config.REGION} with ${ctx.secrets.TOKEN}`,
    );

    await expect(
      runWorkflow(workflow, {
        adapter: { integrations: fakeIntegrations() },
        input: { name: "Ada" },
        trigger: manual,
        config: { REGION: "eu" },
        secrets: { TOKEN: "t0k" },
      }),
    ).resolves.toBe("Ada via run in eu with t0k");
  });

  it("hands the workflow the adapter's integrations", async () => {
    const integrations = fakeIntegrations();
    const workflow = defineWorkflow<void, WorkflowIntegrations>(async (ctx) => ctx.integrations);

    await expect(
      runWorkflow(workflow, { adapter: { integrations }, input: undefined, trigger: manual }),
    ).resolves.toBe(integrations);
  });

  it("runs every step through the adapter's step executor", async () => {
    const recorded: string[] = [];
    const adapter: WorkflowAdapter = {
      integrations: fakeIntegrations(),
      step: async (name, operation) => {
        recorded.push(name);
        return await operation();
      },
    };
    const double = defineStep("Double", async (_ctx: WorkflowContext, value: number) => value * 2);
    const workflow = defineWorkflow<void, number>(async (ctx) => await double(ctx, 21));

    await expect(runWorkflow(workflow, { adapter, input: undefined, trigger: manual })).resolves.toBe(42);
    expect(recorded).toEqual(["Double"]);
  });

  it("runs a step inline when the adapter supplies no step executor", async () => {
    const double = defineStep("Double", async (_ctx: WorkflowContext, value: number) => value * 2);
    const workflow = defineWorkflow<void, number>(async (ctx) => await double(ctx, 21));

    await expect(
      runWorkflow(workflow, { adapter: { integrations: fakeIntegrations() }, input: undefined, trigger: manual }),
    ).resolves.toBe(42);
  });

  it("uses the adapter's log, clock and randomness", async () => {
    const log = vi.fn();
    const workflow = defineWorkflow<void, number[]>(async (ctx) => {
      ctx.log("tick", { at: ctx.now() });
      return [ctx.now(), ctx.random()];
    });

    await expect(
      runWorkflow(workflow, {
        adapter: { integrations: fakeIntegrations(), log, now: () => 7, random: () => 0.5 },
        input: undefined,
        trigger: manual,
      }),
    ).resolves.toEqual([7, 0.5]);
    expect(log).toHaveBeenCalledWith("tick", { at: 7 });
  });

  it("rejects with the workflow's own error", async () => {
    const failure = new Error("provider refused");
    const workflow = defineWorkflow(async () => {
      throw failure;
    });

    await expect(
      runWorkflow(workflow, { adapter: { integrations: fakeIntegrations() }, input: undefined, trigger: manual }),
    ).rejects.toBe(failure);
  });
});

describe("bindOperations", () => {
  it("binds an operation onto its toolkit namespace", async () => {
    const integrations = bindOperations({} as Record<string, unknown>, {
      "airtable.createRecord": async (input) => ({ created: input }),
    }) as { airtable: { createRecord: (input: unknown) => Promise<unknown> } };

    await expect(integrations.airtable.createRecord({ baseId: "app1" })).resolves.toEqual({
      created: { baseId: "app1" },
    });
  });

  it("binds several operations on one toolkit", () => {
    const integrations = bindOperations({} as Record<string, unknown>, {
      "airtable.createRecord": async () => undefined,
      "airtable.listBases": async () => undefined,
    }) as { airtable: Record<string, unknown> };

    expect(Object.keys(integrations.airtable).sort()).toEqual(["createRecord", "listBases"]);
  });

  it("refuses to overwrite a member the integrations already have", () => {
    const existing = () => undefined;
    const integrations = bindOperations(
      { slack: { postMessage: existing } } as Record<string, unknown>,
      { "slack.postMessage": async () => undefined },
    ) as { slack: { postMessage: unknown } };

    expect(integrations.slack.postMessage).toBe(existing);
  });

  it("leaves a namespace that is not a plain object untouched", () => {
    const http = Object.assign(() => undefined, {});
    const integrations = bindOperations({ http } as Record<string, unknown>, {
      "http.download": async () => undefined,
    });

    expect(integrations.http).toBe(http);
    expect(Object.keys(http)).toEqual([]);
  });

  it.each(["airtable", "airtable.records.create", "", ".create", "airtable.", "1table.create"])(
    "ignores %j, which is not exactly a toolkit and a member",
    (operationId) => {
      const integrations = bindOperations({} as Record<string, unknown>, {
        [operationId]: async () => undefined,
      });

      expect(Object.keys(integrations)).toEqual([]);
    },
  );

  it("does not reach Object.prototype through a __proto__ toolkit", () => {
    const operations = Object.fromEntries([["__proto__.pwn", async () => ({})]]);
    const integrations = bindOperations({} as Record<string, unknown>, operations);

    expect(Object.getPrototypeOf(integrations)).toBe(Object.prototype);
    expect("pwn" in integrations).toBe(false);
    expect(({} as Record<string, unknown>)["pwn"]).toBeUndefined();
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "prototype"])(
    "does not bind %s, which would shadow an inherited member",
    (member) => {
      const integrations = bindOperations({} as Record<string, unknown>, {
        [`airtable.${member}`]: async () => ({}),
      });

      expect(integrations).toEqual({});
    },
  );

  it.each(["constructor", "toString", "hasOwnProperty"])(
    "does not bind a %s toolkit, which would shadow an inherited member of the integrations",
    (toolkit) => {
      const integrations = bindOperations({} as Record<string, unknown>, {
        [`${toolkit}.create`]: async () => ({}),
      });

      expect(Object.keys(integrations)).toEqual([]);
    },
  );

  it.each(["then", "catch", "finally"])("does not bind %s, which would make the namespace thenable", (member) => {
    const integrations = bindOperations({} as Record<string, unknown>, {
      [`airtable.${member}`]: async () => ({}),
    });

    expect(integrations).toEqual({});
  });
});

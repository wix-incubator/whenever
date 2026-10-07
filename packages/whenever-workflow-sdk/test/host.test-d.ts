import { expectTypeOf, test } from "vitest";

import { runWorkflow, type WorkflowAdapter } from "../src/host";
import { defineWorkflow } from "../src/index";

declare const adapter: WorkflowAdapter;

test("runWorkflow resolves to the workflow's output type", () => {
  const workflow = defineWorkflow<{ id: string }, { ok: boolean }>(async () => ({ ok: true }));

  expectTypeOf(
    runWorkflow(workflow, { adapter, input: { id: "1" }, trigger: { type: "manual", key: "run" } }),
  ).resolves.toEqualTypeOf<{ ok: boolean }>();
});

test("runWorkflow requires the workflow's input type", () => {
  const workflow = defineWorkflow<{ id: string }, void>(async () => undefined);

  // @ts-expect-error input must match the workflow's declared input
  void runWorkflow(workflow, { adapter, input: { id: 1 }, trigger: { type: "manual", key: "run" } });
});

import { expectTypeOf, test } from "vitest";

import type { WorkflowContext } from "../src/types";

// Host declarations must be able to add provider members without colliding with SDK names.
declare module "../src/integrations" {
  interface WheneverSlackManagedOperations {
    sendMessage(input: { channel: string; text: string }): Promise<{ ts: string }>;
  }

  // Optional only so the other specs' complete fakes still compile: TS2717 fires on a re-declared
  // name whatever its optionality, so a collision would still fail this file.
  interface WorkflowIntegrations {
    slack?: WheneverSlackManagedOperations;
  }
}

test("a binding can declare any toolkit member on WorkflowIntegrations", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(
    ctx.integrations.slack!.sendMessage({ channel: "C1", text: "hello" }),
  ).toEqualTypeOf<Promise<{ ts: string }>>();
});

test("the built-in http namespace survives the augmentation", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(ctx.integrations.http.get).toBeFunction();
});

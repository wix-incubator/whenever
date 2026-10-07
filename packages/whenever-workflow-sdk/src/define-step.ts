import { workflowStepExecutor } from "./step-runtime";
import type { WorkflowContext } from "./types";

const WORKFLOW_STEP = Symbol.for("@wix/whenever-workflow-sdk/step");

/** A trusted runtime boundary that records one named step invocation. */
export interface WorkflowStepExecutor {
  <T>(name: string, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * A named workflow unit created by `defineStep`. Call it from `defineWorkflow`
 * with the runtime context followed by the step's declared arguments.
 */
export interface WorkflowStep<
  TInput = unknown,
  TArgs extends unknown[] = [],
  TResult = void,
> {
  (ctx: WorkflowContext<TInput>, ...args: TArgs): Promise<TResult>;
  readonly stepName: string;
}

/**
 * Define an exported, callable workflow step. Every invocation is automatically
 * tracked by the runtime; use `ctx.log` for additional human-readable detail.
 */
export function defineStep<
  TInput = unknown,
  TArgs extends unknown[] = [],
  TReturn = void,
>(
  name: string,
  operation: (ctx: WorkflowContext<TInput>, ...args: TArgs) => TReturn,
): WorkflowStep<TInput, TArgs, Awaited<TReturn>> {
  if (name.trim() === "") {
    throw new TypeError("defineStep name must not be empty");
  }

  const step = async (
    ctx: WorkflowContext<TInput>,
    ...args: TArgs
  ): Promise<Awaited<TReturn>> => {
    const executeStep = workflowStepExecutor(ctx);
    if (executeStep === undefined) {
      throw new Error(
        "defineStep can only run with a runtime-created WorkflowContext",
      );
    }
    return await executeStep(name, () => operation(ctx, ...args));
  };

  Object.defineProperties(step, {
    [WORKFLOW_STEP]: { value: true },
    stepName: { value: name, enumerable: true },
  });
  return Object.freeze(step) as WorkflowStep<TInput, TArgs, Awaited<TReturn>>;
}

export function isWorkflowStep(value: unknown): value is WorkflowStep {
  return (
    typeof value === "function" &&
    (value as unknown as Record<symbol, unknown>)[WORKFLOW_STEP] === true
  );
}

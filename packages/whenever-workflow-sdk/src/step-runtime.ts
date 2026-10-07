import type { WorkflowStepExecutor } from "./define-step";
import type { WorkflowContext } from "./types";

const WORKFLOW_STEP_EXECUTOR = Symbol.for(
  "@wix/whenever-workflow-sdk/step-executor",
);

export function attachWorkflowStepExecutor(
  context: WorkflowContext<unknown>,
  executeStep: WorkflowStepExecutor,
): void {
  Object.defineProperty(context, WORKFLOW_STEP_EXECUTOR, {
    value: executeStep,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

export function workflowStepExecutor(
  context: WorkflowContext<unknown>,
): WorkflowStepExecutor | undefined {
  return (context as unknown as Record<symbol, unknown>)[
    WORKFLOW_STEP_EXECUTOR
  ] as WorkflowStepExecutor | undefined;
}

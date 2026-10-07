import type { WorkflowDefinition, WorkflowRun } from "./types";

const WORKFLOW_BRAND = "@wix/whenever-workflow-sdk/workflow";

export function defineWorkflow<TInput = void, TOutput = void>(
  run: WorkflowRun<TInput, TOutput>,
): WorkflowDefinition<TInput, TOutput> {
  return Object.freeze({
    brand: WORKFLOW_BRAND,
    run,
  });
}

export function isWorkflowDefinition(
  value: unknown,
): value is WorkflowDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { brand?: unknown }).brand === WORKFLOW_BRAND
  );
}

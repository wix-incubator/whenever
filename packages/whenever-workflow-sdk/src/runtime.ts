import type { WorkflowStepExecutor } from "./define-step";
import type { WorkflowIntegrations } from "./integrations";
import { attachWorkflowStepExecutor } from "./step-runtime";
import type {
  LogFn,
  WorkflowContext,
  WorkflowTriggerContext,
} from "./types";

export interface CreateWorkflowContextOptions<TInput> {
  input: TInput;
  config?: Readonly<Record<string, string>>;
  secrets?: Readonly<Record<string, string>>;
  trigger: WorkflowTriggerContext;
  step: WorkflowStepExecutor;
  log: LogFn;
  now(): number;
  random(): number;
  integrations: WorkflowIntegrations;
}

export function createWorkflowContext<TInput>(
  options: CreateWorkflowContextOptions<TInput>,
): WorkflowContext<TInput> {
  const config = Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, options.config),
  );
  const secrets = Object.freeze(
    Object.assign(Object.create(null) as Record<string, string>, options.secrets),
  );
  const context: WorkflowContext<TInput> = {
    input: options.input,
    config,
    secrets,
    trigger: options.trigger,
    log: options.log,
    now: options.now,
    random: options.random,
    integrations: options.integrations,
  };
  attachWorkflowStepExecutor(context, options.step);
  return context;
}

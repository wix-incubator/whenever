import type { WorkflowStepExecutor } from "./define-step";
import type { WorkflowIntegrations } from "./integrations";
import { createWorkflowContext } from "./runtime";
import type { LogFn, WorkflowDefinition, WorkflowTriggerContext } from "./types";

/**
 * What a host supplies to run a workflow. `integrations` is the adapter's implementation of the
 * ports; the rest default to running each step inline, `console.log`, `Date.now` and `Math.random`.
 */
export interface WorkflowAdapter {
  integrations: WorkflowIntegrations;
  step?: WorkflowStepExecutor;
  log?: LogFn;
  now?: () => number;
  random?: () => number;
}

export interface RunWorkflowOptions<TInput> {
  adapter: WorkflowAdapter;
  input: TInput;
  trigger: WorkflowTriggerContext;
  config?: Readonly<Record<string, string>>;
  secrets?: Readonly<Record<string, string>>;
}

/** Runs one workflow invocation on the given adapter and resolves to the workflow's output. */
export async function runWorkflow<TInput, TOutput>(
  workflow: WorkflowDefinition<TInput, TOutput>,
  { adapter, input, trigger, config, secrets }: RunWorkflowOptions<TInput>,
): Promise<TOutput> {
  const context = createWorkflowContext({
    input,
    trigger,
    ...(config === undefined ? {} : { config }),
    ...(secrets === undefined ? {} : { secrets }),
    step: adapter.step ?? runStepInline,
    log: adapter.log ?? logToConsole,
    now: adapter.now ?? Date.now,
    random: adapter.random ?? Math.random,
    integrations: adapter.integrations,
  });
  return await workflow.run(context);
}

/** One provider operation, called as `ctx.integrations.<toolkit>.<member>(input)`. */
export type OperationHandler = (input: unknown) => Promise<unknown>;

/**
 * Binds each `"toolkit.member"` handler onto `integrations[toolkit][member]` and returns
 * `integrations`. An id that is not exactly two identifier segments, a member that is already
 * present, and a namespace that is not a plain object are left alone.
 */
export function bindOperations<T extends object>(
  integrations: T,
  operations: Readonly<Record<string, OperationHandler>>,
): T {
  const namespaces = integrations as Record<string, unknown>;
  for (const [operationId, handler] of Object.entries(operations)) {
    const segments = operationId.split(".");
    if (segments.length !== 2) continue;
    const [toolkit, member] = segments as [string, string];
    if (!isBindableName(toolkit) || !isBindableName(member)) continue;
    const namespace = Object.prototype.hasOwnProperty.call(namespaces, toolkit)
      ? namespaces[toolkit]
      : undefined;
    if (namespace !== undefined && !isPlainObject(namespace)) continue;
    const target = namespace ?? {};
    if (!(member in target)) target[member] = handler;
    namespaces[toolkit] = target;
  }
  return integrations;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z\d_]*$/u;
// Inherited names would shadow Object.prototype; then/catch/finally would make a namespace thenable.
const RESERVED = new Set(["__proto__", "prototype", "constructor", "then", "catch", "finally"]);

function isBindableName(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name) && !(name in Object.prototype);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

async function runStepInline<T>(_name: string, operation: () => T | Promise<T>): Promise<T> {
  return await operation();
}

function logToConsole(message: string, data?: Record<string, unknown>): void {
  if (data === undefined) console.log(message);
  else console.log(message, data);
}

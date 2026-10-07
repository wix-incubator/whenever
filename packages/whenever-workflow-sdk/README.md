# @wix/whenever-workflow-sdk

Typed workflow definitions, steps, triggers, integration ports and errors. The root entry point
declares workflows; `/host` executes one invocation with a host-supplied adapter.

## Development

Public npm publishing is not enabled yet. See the repository README for workspace setup.

## Defining and running a workflow

```ts
import { defineStep, defineWorkflow } from "@wix/whenever-workflow-sdk";
import { runWorkflow } from "@wix/whenever-workflow-sdk/host";
import { createWorkflowIntegrationsFromEnv } from "@wix/whenever-adapter-standalone";

const greet = defineStep("Greet", async (_ctx, name: string) => `Hello, ${name}`);
const workflow = defineWorkflow<{ name: string }, string>(async (ctx) => greet(ctx, ctx.input.name));
const result = await runWorkflow(workflow, {
  adapter: { integrations: createWorkflowIntegrationsFromEnv({}) },
  input: { name: "Ada" },
  trigger: { type: "manual", key: "run" },
});
```

Return a value that describes what the workflow did. `defineStep` reports execution events to the
host. Read time and randomness through `ctx.now()` and `ctx.random()`; avoid ambient sources such
as `Date.now()` and `Math.random()`. Use `ctx.log()` for annotations and never log credentials.

## Triggers

Trigger constructors declare data. Every trigger needs a non-empty, workflow-local `key`.
`manual`, `schedule`, `once`, `interval`, `hourly`, `daily`, `weekly` and `monthly` describe manual
or scheduled invocations. Cron expressions have five fields; time-of-day values use `HH:MM`.
`webhook` describes an unverified HTTP endpoint. Sender-specific helpers are exported from
`@wix/whenever-workflow-sdk/webhooks`. `event` declares a provider event interpreted by the host.

The host owns scheduling, webhook registration and verification, event subscriptions and activation.
Declaring a trigger does not perform any of those operations.

## Integrations

`ctx.integrations` exposes `ai`, `http`, `mcp` and `postgres` ports. The standalone adapter implements
HTTP and MCP transports and accepts host-supplied AI generation and read-only Postgres execution.
Additional provider bindings extend `WorkflowIntegrations` through TypeScript module augmentation.
Types alone do not establish that a host implements an operation.

Workflow code calls integration ports rather than reading environment variables or credentials.
The host configures credentials, authorization, deadlines and retry policy. `RetryableError` and
`NonRetryableError` let adapters report whether an operation may be retried.

## Entry points

- The root entry point declares workflows, steps, triggers, types and errors.
- `/host` runs a workflow using a supplied adapter.
- `/webhooks` declares sender-specific webhook descriptors.
- `/contract` contains generated authoring documentation and export information.

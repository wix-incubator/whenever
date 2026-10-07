# Whenever SDK and standalone adapter

TypeScript packages for authoring and hosting workflows.

- `@wix/whenever-workflow-sdk` declares workflow definitions, steps, triggers, integration ports and errors. Its `/host` entry point runs a workflow with a host-supplied adapter.
- `@wix/whenever-adapter-standalone` implements HTTP and MCP transports and validates host-supplied AI and Postgres ports. The host supplies credentials and any additional provider bindings.

## Development

Use Node.js 26.3.1 and the checked-in Yarn 4.6.0 release.

```sh
yarn install --immutable
yarn check
```

The root `build`, `typecheck`, `lint`, `depcruise`, and `test` scripts run across packages through Turbo. Turbo builds required dependencies first; the adapter resolves the SDK's compiled declarations.

`yarn check` runs these tasks through Turbo, which builds dependencies first and caches task results and compiled output. To run checks without using cached results, use `yarn check --force`.

## Hosting a workflow

```ts
import { defineWorkflow } from "@wix/whenever-workflow-sdk";
import { runWorkflow } from "@wix/whenever-workflow-sdk/host";
import { createWorkflowIntegrationsFromEnv } from "@wix/whenever-adapter-standalone";

const workflow = defineWorkflow<{ name: string }, string>(async (ctx) => `Hello, ${ctx.input.name}`);
const output = await runWorkflow(workflow, {
  adapter: { integrations: createWorkflowIntegrationsFromEnv({}) },
  input: { name: "Ada" },
  trigger: { type: "manual", key: "run" },
});
```

A host supplies AI generation and Postgres execution when needed. Declaring a trigger does not schedule a job, register a webhook or publish a workflow. The host owns those operations and retry policy.

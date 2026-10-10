# Whenever SDK and standalone adapter

Build a workflow automation locally with your coding agent, then deploy it to [Whenever](https://www.whenever.dev/?utm_source=github&utm_medium=readme&utm_campaign=whenever_beta_launch), which runs it as code on a schedule, a webhook, an event or on demand, with managed credentials and a run log. Your agent writes typed TypeScript against this SDK; the deployed workflow runs on its own trigger, without the agent.

**Get started:** [www.whenever.dev](https://www.whenever.dev/?utm_source=github&utm_medium=readme&utm_campaign=whenever_beta_launch) · [Docs](https://www.whenever.dev/docs?utm_source=github&utm_medium=readme&utm_campaign=whenever_beta_launch) · [MCP setup](https://www.whenever.dev/mcp?utm_source=github&utm_medium=readme&utm_campaign=whenever_beta_launch)

```ts
import {
  daily,
  defineStep,
  defineWorkflow,
  manual,
  RetryableError,
  type WorkflowContext,
  type WorkflowManifest,
} from "@wix/whenever-workflow-sdk";

export const manifest: WorkflowManifest = {
  name: "daily-rate-report",
  triggers: [daily({ key: "morning-report", at: "09:00", tz: "Europe/Vilnius" }), manual({ key: "rerun" })],
};

export const fileReport = defineStep("file-report", async (ctx: WorkflowContext, rate: number) => {
  const receipt = await ctx.integrations.http.post({
    url: ctx.config.REPORT_URL,
    headers: { Authorization: `Bearer ${ctx.secrets.REPORT_API_KEY}` },
    body: { rate, observedAt: ctx.now() },
  });
  if (receipt.status >= 500) throw new RetryableError("report endpoint is down", { retryAfterMs: 60_000 });
  return receipt;
});

export default defineWorkflow<void, { status: number }>(async (ctx) => {
  const receipt = await fileReport(ctx, 1.08);
  return { status: receipt.status };
});
```

## Use it from your coding agent

### Option 1: paste a prompt (skill.md)

Paste this into any coding tool that can read a URL (Claude Code, Cursor, Codex, Copilot, Windsurf, …):

```text
deploy my workflow automation code, use www.whenever.dev/skill.md
```

[`skill.md`](https://www.whenever.dev/skill.md) is a plain-markdown authoring guide: module shape, determinism rules and the publish sequence. The agent refactors your code into a workflow module and deploys it.

### Option 2: connect the MCP server

The server is `https://mcp.whenever.dev` (streamable HTTP; nothing to install). Your agent can then write, test and save workflows as drafts for you to publish.

| Client | Setup |
| --- | --- |
| Claude Code | `claude mcp add --transport http whenever https://mcp.whenever.dev` (add `--scope user` for all projects) |
| Claude (web/desktop) | Settings → Connectors → Add custom connector → paste the URL |
| Cursor | `~/.cursor/mcp.json`: `{ "mcpServers": { "whenever": { "url": "https://mcp.whenever.dev" } } }` |
| Codex | `~/.codex/config.toml`: `[mcp_servers.whenever]` then `url = "https://mcp.whenever.dev"` |
| VS Code | `.vscode/mcp.json`: `{ "servers": { "whenever": { "type": "http", "url": "https://mcp.whenever.dev" } } }` |

## Packages

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

## Running a workflow locally

Run the workflow above in-process with the standalone adapter. It needs no account and nothing is deployed.

```ts
import { runWorkflow } from "@wix/whenever-workflow-sdk/host";
import { createWorkflowIntegrationsFromEnv } from "@wix/whenever-adapter-standalone";
import workflow from "./daily-rate-report";

const output = await runWorkflow(workflow, {
  adapter: { integrations: createWorkflowIntegrationsFromEnv({}) },
  input: undefined,
  trigger: { type: "manual", key: "rerun" },
  config: { REPORT_URL: "https://example.com/reports" },
  secrets: { REPORT_API_KEY: process.env.REPORT_API_KEY ?? "" },
});
```

The caller supplies AI generation and Postgres execution when the workflow needs them. Running a workflow this way does not schedule its triggers, register a webhook or publish it; deploy through [Whenever](https://www.whenever.dev/?utm_source=github&utm_medium=readme&utm_campaign=whenever_beta_launch) for that.

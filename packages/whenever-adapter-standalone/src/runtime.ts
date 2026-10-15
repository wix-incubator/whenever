import type { WorkflowIntegrations } from "@wix/whenever-workflow-sdk";

import {
  type AiGenerateImagePort,
  type AiGenerateTextPort,
  createAiIntegration,
  unavailableAiGenerateImage,
  unavailableAiGenerateText,
} from "./ai-integration";
import { type ResolveHost } from "./egress";
import type { FetchLike } from "./http";
import { createHttpIntegrationFromEnv } from "./http-integration";
import { createMcpIntegrationFromEnv } from "./mcp-integration";
import {
  createPostgresIntegration,
  type PostgresQueryPort,
  unavailablePostgresQuery,
} from "./postgres-integration";
import {
  createWebIntegration,
  unavailableWebListLinks,
  unavailableWebReadPage,
  unavailableWebSearch,
  type WebListLinksPort,
  type WebReadPagePort,
  type WebSearchPort,
} from "./web-integration";

export interface CreateWorkflowIntegrationsFromEnvOptions {
  fetch?: FetchLike;
  /** See McpIntegrationOptions.probeFetch. Defaults to `fetch`. */
  probeFetch?: FetchLike;
  resolveHost?: ResolveHost;
  generateImage?: AiGenerateImagePort;
  generateText?: AiGenerateTextPort;
  queryPostgres?: PostgresQueryPort;
  searchWeb?: WebSearchPort;
  readWebPage?: WebReadPagePort;
  listWebLinks?: WebListLinksPort;
}

export function createWorkflowIntegrationsFromEnv(
  options: CreateWorkflowIntegrationsFromEnvOptions,
): WorkflowIntegrations {
  const fetchImplementation: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const resolveHost = options.resolveHost ?? defaultResolveHost();
  const egressOptions = resolveHost === undefined ? {} : { resolveHost };

  return {
    ai: createAiIntegration({
      generateImage: options.generateImage ?? unavailableAiGenerateImage(),
      generateText: options.generateText ?? unavailableAiGenerateText(),
    }),
    http: createHttpIntegrationFromEnv({
      fetch: fetchImplementation,
      ...egressOptions,
    }),
    mcp: createMcpIntegrationFromEnv({
      fetch: fetchImplementation,
      ...(options.probeFetch === undefined
        ? {}
        : { probeFetch: options.probeFetch }),
      ...egressOptions,
    }),
    postgres: createPostgresIntegration({
      query: options.queryPostgres ?? unavailablePostgresQuery(),
    }),
    web: createWebIntegration({
      search: options.searchWeb ?? unavailableWebSearch(),
      readPage: options.readWebPage ?? unavailableWebReadPage(),
      listLinks: options.listWebLinks ?? unavailableWebListLinks(),
    }),
  };
}

function defaultResolveHost(): ResolveHost | undefined {
  const runtime = globalThis as typeof globalThis & {
    process?: { versions?: { node?: string } };
  };
  if (runtime.process?.versions?.node === undefined) return undefined;
  return async (hostname) => {
    const { lookup } = await import("node:dns/promises");
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  };
}

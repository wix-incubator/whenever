import {
  NonRetryableError,
  type WebIntegration,
  type WebListLinksResult,
  type WebPageInput,
  type WebReadPageResult,
  type WebSearchInput,
  type WebSearchResult,
} from "@wix/whenever-workflow-sdk";

export const WEB_SEARCH_DEFAULT_LIMIT = 5;
export const WEB_SEARCH_MAX_LIMIT = 10;
export const WEB_SEARCH_MAX_QUERY_CHARS = 500;
export const WEB_PAGE_MAX_URL_CHARS = 2_048;
/** Hosts cut page content at this many characters and report `truncated`. */
export const WEB_PAGE_MAX_MARKDOWN_CHARS = 200_000;
/** Hosts cut a link list at this many links and report `truncated`. */
export const WEB_PAGE_MAX_LINKS = 500;
/** The refusal code of a host that supplies no web implementation. */
export const WEB_UNAVAILABLE = "WEB_UNAVAILABLE";

export type WebSearchPort = (
  input: Required<WebSearchInput>,
) => Promise<WebSearchResult>;
export type WebReadPagePort = (input: WebPageInput) => Promise<WebReadPageResult>;
export type WebListLinksPort = (input: WebPageInput) => Promise<WebListLinksResult>;

export interface WebIntegrationOptions {
  search: WebSearchPort;
  readPage: WebReadPagePort;
  listLinks: WebListLinksPort;
}

function invalidWebInput(message: string): NonRetryableError {
  return new NonRetryableError(`Invalid web request: ${message}.`, {
    code: "INPUT_INVALID",
  });
}

function inputRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidWebInput("the input must be an object");
  }
  return input as Record<string, unknown>;
}

export function prepareWebSearchInput(input: unknown): Required<WebSearchInput> {
  const record = inputRecord(input);
  if (typeof record.query !== "string") {
    throw invalidWebInput("query must be a string");
  }
  const query = record.query.trim();
  if (query === "") throw invalidWebInput("query is required");
  if (query.length > WEB_SEARCH_MAX_QUERY_CHARS) {
    throw invalidWebInput("query is too long");
  }
  let limit = WEB_SEARCH_DEFAULT_LIMIT;
  if (record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isSafeInteger(record.limit)) {
      throw invalidWebInput("limit must be an integer");
    }
    if (record.limit < 1 || record.limit > WEB_SEARCH_MAX_LIMIT) {
      throw invalidWebInput(
        `limit must be between 1 and ${String(WEB_SEARCH_MAX_LIMIT)}`,
      );
    }
    limit = record.limit;
  }
  return { query, limit };
}

export function prepareWebPageInput(input: unknown): WebPageInput {
  const record = inputRecord(input);
  if (typeof record.url !== "string") throw invalidWebInput("url must be a string");
  const raw = record.url.trim();
  if (raw === "") throw invalidWebInput("url is required");
  if (raw.length > WEB_PAGE_MAX_URL_CHARS) throw invalidWebInput("url is too long");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidWebInput("url must be an absolute http or https address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidWebInput("url must be an absolute http or https address");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidWebInput("url must not contain credentials");
  }
  // Hosts receive the address these checks judged, not a raw string another parser may read differently.
  const url = parsed.href;
  if (url.length > WEB_PAGE_MAX_URL_CHARS) throw invalidWebInput("url is too long");
  if (record.fresh === undefined) return { url };
  if (typeof record.fresh !== "boolean") throw invalidWebInput("fresh must be a boolean");
  return { url, fresh: record.fresh };
}

function unavailable(operation: string): NonRetryableError {
  return new NonRetryableError(
    "Public web access requires a host-supplied implementation",
    { code: WEB_UNAVAILABLE, operation },
  );
}

export function unavailableWebSearch(): WebSearchPort {
  return async () => {
    throw unavailable("web.search");
  };
}

export function unavailableWebReadPage(): WebReadPagePort {
  return async () => {
    throw unavailable("web.readPage");
  };
}

export function unavailableWebListLinks(): WebListLinksPort {
  return async () => {
    throw unavailable("web.listLinks");
  };
}

export function createWebIntegration(options: WebIntegrationOptions): WebIntegration {
  return {
    async search(input) {
      return await options.search(prepareWebSearchInput(input));
    },
    async readPage(input) {
      return await options.readPage(prepareWebPageInput(input));
    },
    async listLinks(input) {
      return await options.listLinks(prepareWebPageInput(input));
    },
  };
}

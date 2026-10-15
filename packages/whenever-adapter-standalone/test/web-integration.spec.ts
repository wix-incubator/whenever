import { describe, expect, it, vi } from "vitest";

import { createWorkflowIntegrationsFromEnv } from "../src/runtime";
import {
  createWebIntegration,
  prepareWebPageInput,
  prepareWebSearchInput,
  unavailableWebListLinks,
  unavailableWebReadPage,
  unavailableWebSearch,
  WEB_PAGE_MAX_URL_CHARS,
  WEB_SEARCH_MAX_LIMIT,
  WEB_SEARCH_MAX_QUERY_CHARS,
  type WebListLinksPort,
  type WebReadPagePort,
  type WebSearchPort,
} from "../src/web-integration";

const source = {
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  status: 200,
};

describe("prepareWebSearchInput", () => {
  it("defaults the result limit and trims the query", () => {
    expect(prepareWebSearchInput({ query: "  supplier lead times " })).toEqual({
      query: "supplier lead times",
      limit: 5,
    });
  });

  it("accepts a query and limit at their ceilings", () => {
    const query = "q".repeat(WEB_SEARCH_MAX_QUERY_CHARS);

    expect(
      prepareWebSearchInput({ query, limit: WEB_SEARCH_MAX_LIMIT }),
    ).toEqual({ query, limit: WEB_SEARCH_MAX_LIMIT });
  });

  it.each([
    ["a bare string", "news", "the input must be an object"],
    ["null", null, "the input must be an object"],
    ["a list", [{ query: "news" }], "the input must be an object"],
    ["a query that is not text", { query: 1 }, "query must be a string"],
    ["a query of only whitespace", { query: "  " }, "query is required"],
    [
      "a query past its length limit",
      { query: "q".repeat(WEB_SEARCH_MAX_QUERY_CHARS + 1) },
      "query is too long",
    ],
    ["a fractional limit", { query: "news", limit: 1.5 }, "limit must be an integer"],
    ["a limit written as text", { query: "news", limit: "5" }, "limit must be an integer"],
    ["a limit of zero", { query: "news", limit: 0 }, "limit must be between"],
    [
      "a limit past the ceiling",
      { query: "news", limit: WEB_SEARCH_MAX_LIMIT + 1 },
      "limit must be between",
    ],
  ])("refuses %s as invalid input naming the fault", (_case, input, fault) => {
    expect(() => prepareWebSearchInput(input)).toThrow(
      expect.objectContaining({
        code: "INPUT_INVALID",
        retryable: false,
        message: expect.stringContaining(fault) as unknown,
      }),
    );
  });
});

describe("prepareWebPageInput", () => {
  it("keeps a public page address and leaves freshness to the provider by default", () => {
    expect(prepareWebPageInput({ url: " https://example.com/a?b=1 " })).toEqual({
      url: "https://example.com/a?b=1",
    });
  });

  it.each([
    ["a backslash a URL parser reads as a path", "https://example.com\\user:pw@other.com/", "https://example.com/user:pw@other.com/"],
    ["a tab inside the host", "https://exa\tmple.com/", "https://example.com/"],
    ["a scheme without slashes", "https:example.com", "https://example.com/"],
  ])("sends the address it checked, normalizing %s", (_case, url, checked) => {
    expect(prepareWebPageInput({ url })).toEqual({ url: checked });
  });

  it("measures the length cap on the address it sends", () => {
    const url = `https://example.com/${"é".repeat(WEB_PAGE_MAX_URL_CHARS / 4)}`;

    expect(() => prepareWebPageInput({ url })).toThrow(
      expect.objectContaining({ code: "INPUT_INVALID", message: expect.stringContaining("url is too long") as unknown }),
    );
  });

  it("carries an explicit request for fresh data", () => {
    expect(
      prepareWebPageInput({ url: "http://example.com/", fresh: true }),
    ).toEqual({ url: "http://example.com/", fresh: true });
  });

  it.each([
    ["a bare string", "https://example.com/", "the input must be an object"],
    ["a url that is not text", { url: 1 }, "url must be a string"],
    ["a url of only whitespace", { url: " " }, "url is required"],
    [
      "a url past its length limit",
      { url: `https://example.com/${"a".repeat(WEB_PAGE_MAX_URL_CHARS)}` },
      "url is too long",
    ],
    ["a relative address", { url: "/pricing" }, "url must be an absolute http or https address"],
    ["a non-web scheme", { url: "file:///etc/passwd" }, "url must be an absolute http or https address"],
    [
      "an address carrying credentials",
      { url: "https://user:secret@example.com/" },
      "url must not contain credentials",
    ],
    ["freshness written as text", { url: "https://example.com/", fresh: "yes" }, "fresh must be a boolean"],
  ])("refuses %s as invalid input naming the fault", (_case, input, fault) => {
    expect(() => prepareWebPageInput(input)).toThrow(
      expect.objectContaining({
        code: "INPUT_INVALID",
        retryable: false,
        message: expect.stringContaining(fault) as unknown,
      }),
    );
  });
});

describe("createWebIntegration", () => {
  const ports = (
    overrides: Partial<{
      search: WebSearchPort;
      readPage: WebReadPagePort;
      listLinks: WebListLinksPort;
    }> = {},
  ) =>
    createWebIntegration({
      search: overrides.search ?? unavailableWebSearch(),
      readPage: overrides.readPage ?? unavailableWebReadPage(),
      listLinks: overrides.listLinks ?? unavailableWebListLinks(),
    });

  it("hands the prepared search to the port and returns its results", async () => {
    const search = vi.fn<WebSearchPort>(async () => ({
      results: [{ url: "https://example.com/", title: "Example" }],
    }));

    await expect(
      ports({ search }).search({ query: " news " }),
    ).resolves.toEqual({ results: [{ url: "https://example.com/", title: "Example" }] });
    expect(search).toHaveBeenCalledWith({ query: "news", limit: 5 });
  });

  it("hands the prepared page read to the port and returns its observation", async () => {
    const readPage = vi.fn<WebReadPagePort>(async () => ({
      source,
      markdown: "# Example",
      truncated: false,
    }));

    await expect(
      ports({ readPage }).readPage({ url: " https://example.com/ ", fresh: true }),
    ).resolves.toEqual({ source, markdown: "# Example", truncated: false });
    expect(readPage).toHaveBeenCalledWith({ url: "https://example.com/", fresh: true });
  });

  it("hands the prepared link listing to the port and returns its observation", async () => {
    const listLinks = vi.fn<WebListLinksPort>(async () => ({
      source,
      links: [],
      truncated: false,
    }));

    await expect(
      ports({ listLinks }).listLinks({ url: "https://example.com/" }),
    ).resolves.toEqual({ source, links: [], truncated: false });
    expect(listLinks).toHaveBeenCalledWith({ url: "https://example.com/" });
  });

  it("refuses invalid input before reaching the port", async () => {
    const readPage = vi.fn<WebReadPagePort>();

    await expect(
      ports({ readPage }).readPage({ url: "ftp://example.com/" }),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(readPage).not.toHaveBeenCalled();
  });
});

describe("createWorkflowIntegrationsFromEnv", () => {
  it.each([
    ["web.search", async (web: ReturnType<typeof createWebIntegration>) =>
      await web.search({ query: "news" })],
    ["web.readPage", async (web: ReturnType<typeof createWebIntegration>) =>
      await web.readPage({ url: "https://example.com/" })],
    ["web.listLinks", async (web: ReturnType<typeof createWebIntegration>) =>
      await web.listLinks({ url: "https://example.com/" })],
  ])("refuses %s as unavailable when this host supplies no implementation", async (operation, call) => {
    const { web } = createWorkflowIntegrationsFromEnv({});

    await expect(call(web)).rejects.toMatchObject({
      code: "WEB_UNAVAILABLE",
      retryable: false,
      operation,
    });
  });

  it("uses the injected web ports", async () => {
    const { web } = createWorkflowIntegrationsFromEnv({
      searchWeb: async () => ({ results: [] }),
      readWebPage: async () => ({ source, markdown: "", truncated: false }),
      listWebLinks: async () => ({ source, links: ["https://example.com/a"], truncated: true }),
    });

    await expect(web.search({ query: "news" })).resolves.toEqual({ results: [] });
    await expect(web.readPage({ url: "https://example.com/" })).resolves.toEqual({
      source,
      markdown: "",
      truncated: false,
    });
    await expect(web.listLinks({ url: "https://example.com/" })).resolves.toEqual({
      source,
      links: ["https://example.com/a"],
      truncated: true,
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  createPostgresIntegration,
  POSTGRES_QUERY_MAX_PARAMS,
  POSTGRES_QUERY_MAX_ROWS,
  POSTGRES_QUERY_MAX_SQL_CHARS,
  preparePostgresQueryInput,
  unavailablePostgresQuery,
} from "../src/postgres-integration";
import { createWorkflowIntegrationsFromEnv } from "../src/runtime";

describe("preparePostgresQueryInput", () => {
  it("defaults maxRows and keeps parameterized sql", () => {
    expect(
      preparePostgresQueryInput({ sql: " select 1 as n ", params: [1] }),
    ).toEqual({
      sql: "select 1 as n",
      params: [1],
      maxRows: 500,
    });
  });

  it.each([
    ["a statement with no object around it", "select 1", "the input must be an object"],
    ["null", null, "the input must be an object"],
    ["a list", [{ sql: "select 1" }], "the input must be an object"],
    ["sql that is not text", { sql: 1 }, "sql must be a string"],
    ["sql of only whitespace", { sql: "  " }, "sql is required"],
    [
      "sql past its length limit",
      { sql: "s".repeat(POSTGRES_QUERY_MAX_SQL_CHARS + 1) },
      "sql is too long",
    ],
    ["params that are not a list", { sql: "select 1", params: "1" }, "params must be an array"],
    [
      "more params than the limit",
      { sql: "select 1", params: Array.from({ length: POSTGRES_QUERY_MAX_PARAMS + 1 }, () => 1) },
      "too many params",
    ],
    ["a fractional row cap", { sql: "select 1", maxRows: 1.5 }, "maxRows must be an integer"],
    ["a row cap written as text", { sql: "select 1", maxRows: "10" }, "maxRows must be an integer"],
    ["a row cap of zero", { sql: "select 1", maxRows: 0 }, "maxRows must be between"],
    [
      "a row cap past the limit",
      { sql: "select 1", maxRows: POSTGRES_QUERY_MAX_ROWS + 1 },
      "maxRows must be between",
    ],
  ])("refuses %s as invalid input naming the fault", (_case, input, fault) => {
    expect(() => preparePostgresQueryInput(input)).toThrow(
      expect.objectContaining({
        code: "INPUT_INVALID",
        retryable: false,
        message: expect.stringContaining(fault) as unknown,
      }),
    );
  });

  it("accepts a query at the ceiling of every limit", () => {
    const sql = "s".repeat(POSTGRES_QUERY_MAX_SQL_CHARS);
    const params = Array.from({ length: POSTGRES_QUERY_MAX_PARAMS }, (_, at) => at);

    expect(
      preparePostgresQueryInput({ sql, params, maxRows: POSTGRES_QUERY_MAX_ROWS }),
    ).toEqual({ sql, params, maxRows: POSTGRES_QUERY_MAX_ROWS });
  });

  it("accepts a row cap of one", () => {
    expect(preparePostgresQueryInput({ sql: "select 1", maxRows: 1 })).toEqual({
      sql: "select 1",
      maxRows: 1,
    });
  });
});

describe("createPostgresIntegration", () => {
  it("hands the prepared query to the port", async () => {
    const integration = createPostgresIntegration({
      query: async () => ({
        rows: [{ n: 1 }],
        rowCount: 1,
        truncated: false,
      }),
    });

    await expect(
      integration.query({ sql: "select 1 as n" }),
    ).resolves.toEqual({
      rows: [{ n: 1 }],
      rowCount: 1,
      truncated: false,
    });
  });
});

describe("createWorkflowIntegrationsFromEnv", () => {
  it("exposes postgres.query and refuses when this host has no driver", async () => {
    const integrations = createWorkflowIntegrationsFromEnv({});

    await expect(
      integrations.postgres.query({ sql: "select 1" }),
    ).rejects.toMatchObject({ code: "POSTGRES_UNAVAILABLE" });
  });

  it("uses the injected query port", async () => {
    const integrations = createWorkflowIntegrationsFromEnv({
      queryPostgres: async () => ({
        rows: [],
        rowCount: 0,
        truncated: false,
      }),
    });

    await expect(
      integrations.postgres.query({ sql: "select 1" }),
    ).resolves.toEqual({ rows: [], rowCount: 0, truncated: false });
  });
});

describe("unavailablePostgresQuery", () => {
  it("names the missing driver", async () => {
    await expect(unavailablePostgresQuery()({ sql: "select 1" })).rejects.toMatchObject({
      code: "POSTGRES_UNAVAILABLE",
    });
  });
});

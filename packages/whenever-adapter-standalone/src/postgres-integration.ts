import {
  NonRetryableError,
  type PostgresQueryInput,
  type PostgresQueryResult,
  type WorkflowPostgres,
} from "@wix/whenever-workflow-sdk";

export const POSTGRES_QUERY_DEFAULT_MAX_ROWS = 500;
export const POSTGRES_QUERY_MAX_ROWS = 2_000;
export const POSTGRES_QUERY_MAX_SQL_CHARS = 32 * 1024;
export const POSTGRES_QUERY_MAX_PARAMS = 50;

export type PostgresQueryPort = (
  input: PostgresQueryInput,
) => Promise<PostgresQueryResult>;

export interface PostgresIntegrationOptions {
  query: PostgresQueryPort;
}

function invalidPostgresQuery(message: string): NonRetryableError {
  return new NonRetryableError(`Invalid postgres query: ${message}.`, {
    code: "INPUT_INVALID",
  });
}

export function preparePostgresQueryInput(input: unknown): PostgresQueryInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidPostgresQuery("the input must be an object");
  }
  const record = input as Record<string, unknown>;
  if (typeof record.sql !== "string") {
    throw invalidPostgresQuery("sql must be a string");
  }
  const sql = record.sql.trim();
  if (sql === "") {
    throw invalidPostgresQuery("sql is required");
  }
  if (sql.length > POSTGRES_QUERY_MAX_SQL_CHARS) {
    throw invalidPostgresQuery("sql is too long");
  }
  let params: unknown[] | undefined;
  if (record.params !== undefined) {
    if (!Array.isArray(record.params)) {
      throw invalidPostgresQuery("params must be an array");
    }
    if (record.params.length > POSTGRES_QUERY_MAX_PARAMS) {
      throw invalidPostgresQuery("too many params");
    }
    params = [...record.params];
  }
  let maxRows = POSTGRES_QUERY_DEFAULT_MAX_ROWS;
  if (record.maxRows !== undefined) {
    if (
      typeof record.maxRows !== "number" ||
      !Number.isSafeInteger(record.maxRows)
    ) {
      throw invalidPostgresQuery("maxRows must be an integer");
    }
    if (record.maxRows < 1 || record.maxRows > POSTGRES_QUERY_MAX_ROWS) {
      throw invalidPostgresQuery(
        `maxRows must be between 1 and ${String(POSTGRES_QUERY_MAX_ROWS)}`,
      );
    }
    maxRows = record.maxRows;
  }
  return params === undefined ? { sql, maxRows } : { sql, params, maxRows };
}

export function unavailablePostgresQuery(): PostgresQueryPort {
  return async () => {
    throw new NonRetryableError(
      "This host has no Postgres driver. Replace postgres.query with a call that uses your own credentials.",
      { code: "POSTGRES_UNAVAILABLE" },
    );
  };
}

export function createPostgresIntegration(
  options: PostgresIntegrationOptions,
): WorkflowPostgres {
  return {
    async query(input) {
      return await options.query(preparePostgresQueryInput(input));
    },
  };
}

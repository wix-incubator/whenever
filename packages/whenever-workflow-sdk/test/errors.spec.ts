import { describe, expect, it } from "vitest";

import {
  NonRetryableError,
  RetryableError,
  WorkflowError,
} from "../src/errors";

describe("RetryableError", () => {
  it("is an Error and a WorkflowError", () => {
    const err = new RetryableError("temporary");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorkflowError);
  });

  it("is retryable and carries retryAfterMs", () => {
    const err = new RetryableError("temporary", { retryAfterMs: 30000 });

    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(30000);
  });

  it("defaults code to the class name", () => {
    const err = new RetryableError("temporary");

    expect(err.code).toBe("RetryableError");
  });
});

describe("NonRetryableError", () => {
  it("is not retryable", () => {
    const err = new NonRetryableError("permanent");

    expect(err.retryable).toBe(false);
  });

  it("honors a custom code", () => {
    const err = new NonRetryableError("permanent", { code: "INVALID_INPUT" });

    expect(err.code).toBe("INVALID_INPUT");
  });
});

import {
  NonRetryableError,
  RetryableError,
} from "@wix/whenever-workflow-sdk";
import { describe, expect, it } from "vitest";

import { type FetchLike, requestEnvelope } from "../src/http";

const RATE_LIMITED = new RetryableError("The provider is rate limiting this call.", {
  code: "PROVIDER_RATE_LIMITED",
  retryAfterMs: 5_000,
});

function throwing(error: unknown): FetchLike {
  return async () => {
    throw error;
  };
}

function request(
  error: unknown,
  failureMode: "safe" | "write",
): Promise<unknown> {
  return requestEnvelope(throwing(error), "https://api.example/thing", {
    code: "EXAMPLE_API_ERROR",
    failureMode,
  });
}

describe("a refusal the fetch layer already named", () => {
  it("keeps its code on a read", async () => {
    await expect(request(RATE_LIMITED, "safe")).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMITED",
      retryable: true,
      retryAfterMs: 5_000,
    });
  });

  it("keeps its code when the refusal is permanent", async () => {
    await expect(
      request(
        new NonRetryableError("Outside the routed base url.", {
          code: "PROVIDER_ENDPOINT_NOT_ALLOWED",
        }),
        "safe",
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_ENDPOINT_NOT_ALLOWED",
      retryable: false,
    });
  });

  it("loses to the write question, which the name does not answer", async () => {
    await expect(request(RATE_LIMITED, "write")).rejects.toMatchObject({
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
  });

  it("still reads an unnamed transport failure as one", async () => {
    await expect(
      request(new TypeError("fetch failed"), "safe"),
    ).rejects.toMatchObject({
      code: "EXAMPLE_API_ERROR",
      retryable: true,
    });
  });
});

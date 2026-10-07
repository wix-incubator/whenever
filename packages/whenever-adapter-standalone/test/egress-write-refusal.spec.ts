import { describe, expect, it, vi } from "vitest";

import {
  createGuardedFetch,
  type FetchLike,
  type ResolveHost,
} from "../src/index";

const RESOLVES_PUBLIC: ResolveHost = async () => ["93.184.216.34"];

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

const redirecting = (
  status: number,
  body: BodyInit | null = null,
): Response =>
  new Response(body, {
    status,
    headers: { location: "https://api.example.com/moved" },
  });

const writing = (
  fetch: FetchLike,
): Promise<Response> =>
  createGuardedFetch(fetch, { resolveHost: RESOLVES_PUBLIC })(
    "https://api.example.com/submit",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    },
  );

// These assert at the guard rather than through `http.post`, because that adapter reports any
// failure during a write under one code — so through it, a guard that crashed and a guard that
// refused are the same observation.
describe("what the guard itself says when a write is redirected", () => {
  it.each(REDIRECT_STATUSES)(
    "refuses a redirected write, naming the %i it saw",
    async (status) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(redirecting(status));

      await expect(writing(fetch)).rejects.toMatchObject({
        code: "AMBIGUOUS_EXTERNAL_WRITE",
        retryable: false,
        message: `External write received redirect status ${String(status)} and will not be replayed or rewritten.`,
      });
    },
  );

  // The write may already have landed, so the one thing this must not do is send it again.
  it("does not follow the redirect it refused", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(redirecting(302));

    await expect(writing(fetch)).rejects.toThrow();

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("lets go of a redirect body it will not read before refusing", async () => {
    const cancel = vi.fn();
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(redirecting(303, new ReadableStream({ cancel })));

    await expect(writing(fetch)).rejects.toMatchObject({
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  // A method is matched by name whatever case it arrives in, so a reader written in lower case is
  // still a read: refusing it would report an ambiguous write for a request that changes nothing.
  it("follows a redirect for a safe method named in lower case", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirecting(302))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const response = await createGuardedFetch(fetch, {
      resolveHost: RESOLVES_PUBLIC,
    })("https://api.example.com/thing", { method: "get" });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // Cleanup cannot change the verdict: a body that refuses to close still leaves the caller with
  // the ambiguity about its write rather than with the cancellation's own error.
  it("keeps its verdict when the body it lets go of throws", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      redirecting(
        301,
        new ReadableStream({
          cancel() {
            throw new Error("the stream refused to close");
          },
        }),
      ),
    );

    await expect(writing(fetch)).rejects.toMatchObject({
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
  });
});


import { describe, expect, it, vi } from "vitest";

import {
  assertAllowedEgressUrl,
  createGuardedFetch,
  createWorkflowIntegrationsFromEnv,
  EGRESS_MAX_REDIRECTS,
  type FetchLike,
  pinnedAddressLookup,
} from "../src/index";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const publicResolver = async (): Promise<string[]> =>
  await Promise.resolve(["93.184.216.34"]);

function context(fetch: FetchLike) {
  return createWorkflowIntegrationsFromEnv({
    fetch,
    resolveHost: publicResolver,
  });
}

const BLOCKED_TARGETS = [
  ["loopback v4", "http://127.0.0.1/admin"],
  ["loopback name", "http://localhost:8080/admin"],
  ["loopback v6", "http://[::1]/admin"],
  ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
  ["gcp metadata name", "http://metadata.google.internal/computeMetadata/v1/"],
  ["rfc1918 ten", "http://10.1.2.3/internal"],
  ["rfc1918 172", "http://172.16.0.5/internal"],
  ["rfc1918 192", "http://192.168.1.1/internal"],
  ["cgnat", "http://100.64.0.1/internal"],
  ["unique local v6", "http://[fd00::1]/internal"],
  ["link local v6", "http://[fe80::1]/internal"],
  ["ipv4-mapped v6", "http://[::ffff:127.0.0.1]/admin"],
  ["mdns name", "http://printer.local/status"],
  ["unspecified", "http://0.0.0.0/"],
  ["gcp metadata name with a root dot", "http://metadata.google.internal./computeMetadata/v1/"],
  ["mdns name with a root dot", "http://printer.local./status"],
  ["loopback name with a root dot", "http://localhost./admin"],
] as const;

const BLOCKED_IPV6_ADDRESSES = [
  ["deprecated site-local", "fec0::1"],
  ["NAT64 private IPv4", "64:ff9b::a00:1"],
  ["local-use translation", "64:ff9b:1::1"],
  ["IPv4-compatible private", "::10.0.0.1"],
  ["IPv4-mapped public", "::ffff:5db8:d822"],
  ["dummy prefix", "100:0:0:1::1"],
  ["IETF benchmarking", "2001:2::1"],
  ["deprecated ORCHID", "2001:10::1"],
  ["ORCHIDv2", "2001:20::1"],
  ["Drone Remote ID DET", "2001:30::1"],
  ["6to4 private IPv4", "2002:a00:1::"],
  ["SRv6 SID", "5f00::1"],
  ["reserved non-global unicast", "400::1"],
] as const;

const GLOBALLY_REACHABLE_IPV6_ADDRESSES = [
  ["ordinary global unicast", "2606:2800:220:1:248:1893:25c8:1946"],
  ["PCP anycast", "2001:1::1"],
  ["AMT", "2001:3::1"],
  ["AS112-v6", "2001:4:112::1"],
  ["direct-delegation AS112", "2620:4f:8000::1"],
] as const;

describe("http.* egress control", () => {
  it.each(BLOCKED_TARGETS)("refuses a %s target without calling fetch", async (_label, url) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));

    await expect(context(fetch).http.get({ url })).rejects.toThrow(/not allowed|blocked/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(BLOCKED_IPV6_ADDRESSES)(
    "refuses a %s IPv6 literal without calling fetch",
    async (_label, address) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));

      await expect(
        context(fetch).http.get({ url: `https://[${address}]/internal` }),
      ).rejects.toThrow(/not allowed|blocked/iu);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(BLOCKED_IPV6_ADDRESSES)(
    "refuses a hostname resolving to %s IPv6",
    async (_label, address) => {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));
      const resolveHost = vi.fn(async () => [address]);

      await expect(
        createWorkflowIntegrationsFromEnv({
          fetch,
          resolveHost,
        }).http.get({ url: "https://public.example/data" }),
      ).rejects.toThrow(/not allowed|blocked/iu);
      expect(fetch).not.toHaveBeenCalled();
      expect(resolveHost).toHaveBeenCalledWith("public.example");
    },
  );

  it.each(BLOCKED_IPV6_ADDRESSES)(
    "refuses a redirect landing on %s IPv6",
    async (_label, address) => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(redirectTo(`https://[${address}]/internal`));

      await expect(
        context(fetch).http.get({ url: "https://api.example.com/redirect" }),
      ).rejects.toThrow(/not allowed|blocked/iu);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(GLOBALLY_REACHABLE_IPV6_ADDRESSES)(
    "allows a globally reachable %s IPv6 literal",
    async (_label, address) => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValue(jsonResponse({ ok: true }));

      const result = await context(fetch).http.get({
        url: `https://[${address}]/data`,
      });

      expect(result.status).toBe(200);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("allows NAT64 when its embedded IPv4 destination is public", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    const result = await context(fetch).http.get({
      url: "https://[64:ff9b::5db8:d822]/data",
    });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["file", "file:///etc/passwd"],
    ["gopher", "gopher://example.com/"],
    ["data", "data:text/plain,hello"],
  ])("refuses the %s scheme", async (_label, url) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));

    await expect(context(fetch).http.get({ url })).rejects.toThrow(/scheme|not allowed/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows an ordinary public https target", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    const result = await context(fetch).http.get({ url: "https://api.example.com/v1/things" });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that lands on a blocked host", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("http://169.254.169.254/latest/meta-data/"));

    await expect(
      context(fetch).http.get({ url: "https://api.example.com/redirect" }),
    ).rejects.toThrow(/not allowed|blocked/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect that lands on an allowed host", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://cdn.example.com/thing"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await context(fetch).http.get({ url: "https://api.example.com/redirect" });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not follow redirects forever", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(redirectTo("https://example.com/loop"));

    await expect(
      context(fetch).http.get({ url: "https://example.com/loop" }),
    ).rejects.toThrow(/redirect/i);
  });

  it("requests with a manual redirect policy and an abort signal", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.get({ url: "https://api.example.com/thing" });

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("spends one deadline across the whole redirect chain, not one per hop", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://api.example.com/one"))
      .mockResolvedValueOnce(redirectTo("https://api.example.com/two"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await context(fetch).http.get({ url: "https://api.example.com/start" });

    const signals = fetch.mock.calls.map((call) => call[1]?.signal);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
  });

  it("cancels every safe redirect body before following within the shared deadline", async () => {
    const events: string[] = [];
    const redirectWithBody = (location: string, hop: number): Response =>
      new Response(
        new ReadableStream({
          async cancel() {
            events.push(`cancel-${String(hop)}-start`);
            await Promise.resolve();
            events.push(`cancel-${String(hop)}-end`);
          },
        }),
        { status: 302, headers: { location } },
      );
    let hop = 0;
    const fetch = vi.fn<FetchLike>(async (_input, init): Promise<Response> => {
      hop += 1;
      events.push(`fetch-${String(hop)}`);
      expect(init?.signal?.aborted).toBe(false);
      if (hop === 1) {
        return redirectWithBody("https://api.example.com/two", hop);
      }
      if (hop === 2) {
        expect(events).toContain("cancel-1-end");
        return redirectWithBody("https://api.example.com/final", hop);
      }
      expect(events).toContain("cancel-2-end");
      return jsonResponse({ ok: true });
    });

    await context(fetch).http.get({ url: "https://api.example.com/one" });

    expect(events).toEqual([
      "fetch-1",
      "cancel-1-start",
      "cancel-1-end",
      "fetch-2",
      "cancel-2-start",
      "cancel-2-end",
      "fetch-3",
    ]);
    const signals = fetch.mock.calls.map((call) => call[1]?.signal);
    expect(new Set(signals).size).toBe(1);
  });

  it("does not wait past the shared deadline to cancel a safe redirect body", async () => {
    const controller = new AbortController();
    let finishCancellation = (): void => undefined;
    const cancellationPending = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const cancel = vi.fn(async () => await cancellationPending);
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: "https://api.example.com/final" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const guarded = createGuardedFetch(fetch, {
      resolveHost: publicResolver,
      signal: controller.signal,
    });
    const request = guarded("https://api.example.com/start", { method: "GET" });

    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
    });
    const deadlineError = new Error("shared deadline elapsed");
    controller.abort(deadlineError);

    await expect(request).rejects.toBe(deadlineError);
    expect(fetch).toHaveBeenCalledTimes(1);
    finishCancellation();
  });

  it("reports an unparseable redirect target as a blocked request", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("http://[::bad::target]/"));

    await expect(
      context(fetch).http.get({ url: "https://api.example.com/redirect" }),
    ).rejects.toThrow(/redirect/i);
  });

  it("blocks a write to an internal host before the request is made", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));

    await expect(
      context(fetch).http.post({ url: "http://10.0.0.1/hook", body: { a: 1 } }),
    ).rejects.toThrow(/not allowed|blocked/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("redirects do not leak credentials or replay writes", () => {
  it("strips Authorization when a redirect changes origin", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://evil.example.net/collect"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await context(fetch).http.get({
      url: "https://api.example.com/thing",
      headers: { Authorization: "Bearer secret-token", "X-Api-Key": "k-123" },
    });

    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(second.get("authorization")).toBeNull();
    expect(second.get("x-api-key")).toBeNull();
  });

  it("keeps Authorization on a same-origin redirect", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://api.example.com/moved"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await context(fetch).http.get({
      url: "https://api.example.com/thing",
      headers: { Authorization: "Bearer secret-token" },
    });

    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(second.get("authorization")).toBe("Bearer secret-token");
  });

  for (const status of [301, 302, 303, 307, 308] as const) {
    it(`does not follow, rewrite, or replay a POST after a ${String(status)}`, async () => {
      const fetch = vi
        .fn<FetchLike>()
        .mockResolvedValueOnce(
          redirectTo("https://api.example.com/result", status),
        )
        .mockResolvedValueOnce(jsonResponse({ ok: true }));

      await expect(
        context(fetch).http.post({
          url: "https://api.example.com/submit",
          body: { a: 1 },
        }),
      ).rejects.toMatchObject({
        retryable: false,
        code: "AMBIGUOUS_EXTERNAL_WRITE",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it("cancels an unsafe redirect response body before reporting an ambiguous write", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status: 307,
      headers: { location: "https://api.example.com/result" },
    });
    const fetch = vi.fn<FetchLike>().mockResolvedValue(response);

    await expect(
      context(fetch).http.post({
        url: "https://api.example.com/submit",
        body: { a: 1 },
      }),
    ).rejects.toMatchObject({
      retryable: false,
      code: "AMBIGUOUS_EXTERNAL_WRITE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("never replays a workflow's write body onto a redirect target", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://evil.example.net/collect", 307))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      context(fetch).http.post({
        url: "https://api.example.com/submit",
        body: { email: "person@example.test" },
      }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("evil.example.net");
  });

  it("still follows a bodyless cross-origin redirect", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://cdn.example.net/thing", 307))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await context(fetch).http.get({
      url: "https://api.example.com/thing",
    });

    expect(result.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("drops a provider-named credential header the denylist never heard of", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://evil.example.net/collect"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await context(fetch).http.get({
      url: "https://api.example.com/thing",
      headers: {
        "X-Shopify-Access-Token": "shpat_secret",
        "Private-Token": "glpat_secret",
        "X-Correlation-Id": "trace-1",
      },
    });

    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(second.get("x-shopify-access-token")).toBeNull();
    expect(second.get("private-token")).toBeNull();
  });

  it("keeps a provider-named credential header on a same-origin redirect", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://api.example.com/moved"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await context(fetch).http.get({
      url: "https://api.example.com/thing",
      headers: { "X-Shopify-Access-Token": "shpat_secret" },
    });

    const second = new Headers(fetch.mock.calls[1]?.[1]?.headers);
    expect(second.get("x-shopify-access-token")).toBe("shpat_secret");
  });

  it("does not follow a redirect after another unsafe method", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://api.example.com/result", 301))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      context(fetch).http.put({
        url: "https://api.example.com/thing",
        body: { a: 1 },
      }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_EXTERNAL_WRITE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("pins the vetted address so the socket layer cannot re-resolve the host", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.get({ url: "https://api.example.com/thing" });

    const init = fetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it("does not pin when the destination is already an address literal", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await context(fetch).http.get({ url: "https://93.184.216.34/thing" });

    const init = fetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(init?.dispatcher).toBeUndefined();
  });

  it("re-pins every redirect hop to that hop's vetted address", async () => {
    const resolved = ["93.184.216.34", "93.184.216.35"];
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://other.example.com/moved"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await createWorkflowIntegrationsFromEnv({
      fetch,
      resolveHost: async () => await Promise.resolve(resolved),
    }).http.get({ url: "https://api.example.com/thing" });

    for (const call of fetch.mock.calls) {
      const init = call[1] as (RequestInit & { dispatcher?: unknown }) | undefined;
      expect(init?.dispatcher).toBeDefined();
    }
  });

  it("does not follow a redirect status the Fetch standard does not define as one", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://api.example.com/other", 305));

    await expect(
      context(fetch).http.get({ url: "https://api.example.com/thing" }),
    ).rejects.toThrow(/305/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("egress resolves hostnames before trusting them", () => {
  it("refuses a public hostname that resolves into a private range", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));
    const lookup = vi.fn(async () => ["10.0.0.7"]);

    await expect(
      createWorkflowIntegrationsFromEnv({
        fetch,
        resolveHost: lookup,
      }).http.get({ url: "https://sneaky.example.com/data" }),
    ).rejects.toThrow(/not allowed|blocked/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledWith("sneaky.example.com");
  });

  it("allows a hostname that resolves to public addresses", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    const result = await createWorkflowIntegrationsFromEnv({
      fetch,
      resolveHost: publicResolver,
    }).http.get({ url: "https://example.com/data" });

    expect(result.status).toBe(200);
  });

  it("allows and pins a hostname that resolves to globally routable IPv6", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const resolveHost = vi.fn(async () => [
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);

    const result = await createWorkflowIntegrationsFromEnv({
      fetch,
      resolveHost,
    }).http.get({ url: "https://example.com/data" });

    expect(result.status).toBe(200);
    const init = fetch.mock.calls[0]?.[1] as
      | (RequestInit & { dispatcher?: unknown })
      | undefined;
    expect(init?.dispatcher).toBeDefined();
  });

  it("spends the request deadline on resolution, not only on the fetches", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const guarded = createGuardedFetch(fetch, {
      timeoutMs: 20,
      resolveHost: async () => await new Promise<string[]>(() => undefined),
    });

    await expect(guarded("https://api.example.com/thing")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("http.* egress is guarded, and the author's host is resolved", () => {
  function httpContext(fetch: FetchLike, resolveHost = publicResolver) {
    return createWorkflowIntegrationsFromEnv({ fetch, resolveHost });
  }

  it("bounds the request with a manual redirect policy and an abort signal", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await httpContext(fetch).http.get({ url: "https://api.example.com/thing" });

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves the host, because the author chooses it", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({}));
    const lookup = vi.fn(async () => ["10.0.0.7"]);

    await expect(
      httpContext(fetch, lookup).http.get({ url: "https://sneaky.example.com/x" }),
    ).rejects.toThrow(/not allowed|blocked/i);
    expect(lookup).toHaveBeenCalledWith("sneaky.example.com");
  });

  it("does not follow a redirect forever", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(redirectTo("https://api.example.com/thing"));

    await expect(
      httpContext(fetch).http.get({ url: "https://api.example.com/thing" }),
    ).rejects.toThrow(/redirect/i);
  });
});

describe("pinnedAddressLookup", () => {
  function lookup(
    addresses: readonly string[],
    options: Parameters<ReturnType<typeof pinnedAddressLookup>>[1] = {},
  ): unknown[] {
    const received: unknown[] = [];
    pinnedAddressLookup(addresses)("evil.test", options, ((
      ...args: unknown[]
    ) => {
      received.push(...args);
    }) as never);
    return received;
  }

  it("answers with the vetted address instead of resolving the hostname", () => {
    expect(lookup(["93.184.216.34"])).toEqual([null, "93.184.216.34", 4]);
  });

  it("answers every vetted address when the caller asks for all of them", () => {
    expect(lookup(["93.184.216.34", "2606:2800:220:1::1"], { all: true })).toEqual([
      null,
      [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ],
    ]);
  });

  it("keeps the requested address family", () => {
    expect(
      lookup(["93.184.216.34", "2606:2800:220:1::1"], { family: 6 }),
    ).toEqual([null, "2606:2800:220:1::1", 6]);
  });

  // `dns.LookupOptions` admits the family as a name as well as a number, so the port accepts
  // both. Callers in this repo pass a number; these pin the half of the contract they do not use.
  it.each([
    ["IPv4" as const, "93.184.216.34", 4],
    ["IPv6" as const, "2606:2800:220:1::1", 6],
  ])("keeps the requested family named as %s", (family, address, expected) => {
    expect(
      lookup(["93.184.216.34", "2606:2800:220:1::1"], { family }),
    ).toEqual([null, address, expected]);
  });

  it("fails rather than fall back when no vetted address matches the family", () => {
    const [error] = lookup(["93.184.216.34"], { family: 6 });

    expect(error).toBeInstanceOf(Error);
  });
});

// Near-miss addresses must not bypass the guard and expose the host's private network.
describe("egress address parsing near misses", () => {
  const verdictFor = (host: string): string => {
    try {
      assertAllowedEgressUrl(new URL(`http://${host}/x`));
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  const allows = (host: string): boolean => verdictFor(host) === "allowed";

  // The URL parser normalises a short or hex-encoded quad into its canonical form before the
  // guard sees it, which is what closes the two oldest ways of writing a loopback or private
  // address without using its decimal spelling.
  it.each([
    ["a three-octet private address", "10.0.0", "10.0.0.0"],
    ["a hex-encoded loopback", "0x7f.0.0.1", "127.0.0.1"],
    ["an octal-looking loopback", "0177.0.0.1", "127.0.0.1"],
    ["a single-integer loopback", "2130706433", "127.0.0.1"],
  ])("blocks %s, which the parser canonicalises", (_case, host, canonical) => {
    expect(new URL(`http://${host}/x`).hostname).toBe(canonical);
    expect(verdictFor(host)).toContain("private or reserved");
  });

  // A quad the parser will not canonicalise is not an address, so it falls through to the
  // hostname rules rather than being classified by a range it is not in.
  // Chosen so the octets fold into 10.255.255.255 if the digit guard is dropped: a quad that
  // folded to something public would be allowed either way and prove nothing.
  it("does not read a signed octet as an IPv4 address", () => {
    expect(allows("11.0.0.-1")).toBe(true);
  });

  it("reads the highest dotted-quad as an address and blocks it as reserved", () => {
    expect(verdictFor("255.255.255.255")).toContain("private or reserved");
  });

  it("allows the lowest public address in each octet position", () => {
    expect(allows("1.1.1.1")).toBe(true);
    expect(allows("8.8.8.8")).toBe(true);
  });

  // Ranges the existing suite does not name, each reserved by IANA for something other than
  // ordinary reachable hosts.
  it.each([
    ["IETF protocol assignments", "192.0.0.1"],
    ["benchmarking", "198.18.0.1"],
    ["benchmarking upper half", "198.19.255.254"],
    ["multicast", "224.0.0.1"],
    ["multicast upper", "239.255.255.255"],
    ["reserved class E", "240.0.0.1"],
  ])("blocks the %s range", (_case, host) => {
    expect(verdictFor(host)).toContain("private or reserved");
  });

  it.each([
    ["one below the protocol assignments block", "191.255.255.255"],
    ["one past the benchmarking block", "198.20.0.1"],
    ["one below multicast", "223.255.255.255"],
  ])("allows %s, which sits outside the reserved range", (_case, host) => {
    expect(allows(host)).toBe(true);
  });
});

describe("egress IPv6 parsing near misses", () => {
  const verdictFor = (host: string): string => {
    try {
      assertAllowedEgressUrl(new URL(`http://[${host}]/x`));
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  // A malformed spelling — two compression markers, a non-hexadecimal group, five hex digits, or
  // the wrong number of groups — is refused by the URL parser before the guard runs, so the
  // guard's own "not a routable address" branch is unreachable from here. What it does see is the
  // canonical form, including the mapped and compatible forms of a private IPv4 address.

  // All three sit outside 2000::/3, which is what refuses them; the guard never reads the
  // address they embed. The NAT64 block below is the only place an embedded value is consulted.
  it.each([
    ["an IPv4-mapped address", "::ffff:127.0.0.1"],
    ["an IPv4-compatible address", "::10.0.0.1"],
    ["a compressed loopback", "::1"],
  ])("blocks %s for its own prefix", (_case, host) => {
    expect(verdictFor(host)).toContain("private or reserved");
  });

  it("accepts the eight-group form of an ordinary global address", () => {
    expect(verdictFor("2606:2800:220:1:248:1893:25c8:1946")).toBe("allowed");
  });

  it("accepts a compressed global address", () => {
    expect(verdictFor("2606:2800::1")).toBe("allowed");
  });
});

// The NAT64 well-known prefix is the one case classified by the IPv4 address it carries rather
// than by its own prefix, so every group of that prefix has to match before the guard takes
// that route. A near miss must be judged as the ordinary address it is.
describe("egress NAT64 prefix matching", () => {
  const verdictFor = (host: string): string => {
    try {
      assertAllowedEgressUrl(new URL(`http://[${host}]/x`));
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  it("reads the well-known prefix by its embedded address and blocks a private one", () => {
    expect(verdictFor("64:ff9b::a00:1")).toContain("private or reserved");
  });

  it("reads the well-known prefix by its embedded address and allows a public one", () => {
    expect(verdictFor("64:ff9b::5db8:d822")).toBe("allowed");
  });

  // Each of the prefix's six groups is compared, so an address one group away is judged by its
  // own prefix instead. All of these sit outside 2000::/3, so the right answer is still to
  // block — but for the address itself rather than for the public IPv4 it carries.
  it.each([
    ["a different first group", "65:ff9b::5db8:d822"],
    ["a different second group", "64:ff9c::5db8:d822"],
    ["a non-zero third group", "64:ff9b:1::5db8:d822"],
    ["a non-zero fourth group", "64:ff9b:0:1::5db8:d822"],
    ["a non-zero fifth group", "64:ff9b:0:0:1:0:5db8:d822"],
    ["a non-zero sixth group", "64:ff9b:0:0:0:1:5db8:d822"],
  ])(
    "does not treat %s as the well-known prefix",
    (_case, host) => {
      expect(verdictFor(host)).toContain("private or reserved");
    },
  );
});

// 2001::/23 is reserved for special purposes, and three narrow blocks inside it are globally
// reachable. Each exception is exact, so an address one group away from one must stay blocked.
describe("egress special-purpose IPv6 exceptions", () => {
  const verdictFor = (host: string): string => {
    try {
      assertAllowedEgressUrl(new URL(`http://[${host}]/x`));
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  it.each([
    ["the PCP anycast address", "2001:1::1"],
    ["the NAT64 discovery anycast address", "2001:1::2"],
    ["the DNS64 discovery anycast address", "2001:1::3"],
  ])("allows %s", (_case, host) => {
    expect(verdictFor(host)).toBe("allowed");
  });

  it.each([
    ["a fourth anycast address that is not assigned", "2001:1::4"],
    ["the anycast block's own prefix", "2001:1::"],
    ["an anycast address with a non-zero seventh group", "2001:1:0:0:0:0:1:1"],
    ["an anycast address with a non-zero third group", "2001:1:abcd::1"],
    ["an anycast address with a non-zero fourth group", "2001:1:0:beef::2"],
    ["an anycast address with a non-zero fifth group", "2001:1:0:0:cafe:0:0:3"],
    ["an anycast address with a non-zero sixth group", "2001:1:0:0:0:f00d:0:1"],
  ])("blocks %s", (_case, host) => {
    expect(verdictFor(host)).toContain("private or reserved");
  });

  it("allows the AMT block and blocks its neighbour", () => {
    expect(verdictFor("2001:3::1")).toBe("allowed");
    expect(verdictFor("2001:5::1")).toContain("private or reserved");
  });

  it("allows AS112-v6 only where its second and third groups both match", () => {
    expect(verdictFor("2001:4:112::1")).toBe("allowed");
    expect(verdictFor("2001:4:113::1")).toContain("private or reserved");
    expect(verdictFor("2001:5:112::1")).toContain("private or reserved");
  });

  it("blocks the documentation prefix only where both of its groups match", () => {
    expect(verdictFor("2001:db8::1")).toContain("private or reserved");
    expect(verdictFor("2001:db9::1")).toBe("allowed");
    expect(verdictFor("2606:db8::1")).toBe("allowed");
  });

  it("blocks the newer documentation block across its whole range", () => {
    expect(verdictFor("3fff::1")).toContain("private or reserved");
    expect(verdictFor("3fff:0fff::1")).toContain("private or reserved");
  });

  it("allows the address just past the newer documentation block", () => {
    expect(verdictFor("3fff:1000::1")).toBe("allowed");
  });

  it("blocks every 6to4 address regardless of what it embeds", () => {
    expect(verdictFor("2002:a00:1::")).toContain("private or reserved");
    expect(verdictFor("2002:5db8:d822::")).toContain("private or reserved");
  });
});

describe("egress host normalisation", () => {
  const verdictFor = (host: string): string => {
    try {
      assertAllowedEgressUrl(new URL(`http://${host}/x`));
      return "allowed";
    } catch (error) {
      return error instanceof Error ? error.message : "unknown";
    }
  };

  it.each([
    ["ftp:", "ftp://example.test/x"],
    ["file:", "file:///etc/passwd"],
    ["data:", "data:text/plain,hello"],
    ["gopher:", "gopher://example.test/x"],
  ])("refuses the %s scheme", (_case, href) => {
    let message = "allowed";
    try {
      assertAllowedEgressUrl(new URL(href));
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown";
    }

    expect(message).toContain("scheme is not allowed");
  });

  // The parser lowercases a hostname itself, so the guard's own lowercasing is belt-and-braces
  // for a caller handing it a URL-like object built some other way. What these pin is that case
  // is not a way past the blocklist, whichever layer settles it.
  // The parser lowercases a hostname itself, so the guard's own lowercasing is belt-and-braces
  // for a caller handing it a URL-like object built some other way.
  it("blocks an internal name whatever case it is written in", () => {
    expect(verdictFor("METADATA.GOOGLE.INTERNAL")).toContain("internal service");
  });

  it.each([
    ["one trailing dot", "printer.local."],
    ["several trailing dots", "printer.local..."],
  ])("blocks an internal name carrying %s", (_case, host) => {
    expect(verdictFor(host)).toContain("internal service");
  });

  // The short metadata name carries no blocked suffix, so its blocklist entry is the only thing
  // standing between a workflow and the instance metadata service.
  it("blocks the bare metadata hostname", () => {
    expect(verdictFor("metadata")).toContain("internal service");
  });

  // The parser applies UTS-46 and percent-decoding before the guard, which is where this class
  // of blocklist evasion is closed.
  it.each([
    ["fullwidth letters", "ｌｏｃａｌｈｏｓｔ", "localhost"],
    ["ideographic dots", "127。0。0。1", "127.0.0.1"],
    ["percent-encoded letters", "%6C%6F%63%61%6C%68%6F%73%74", "localhost"],
  ])("blocks a host written with %s", (_case, host, canonical) => {
    expect(new URL(`http://${host}/x`).hostname).toBe(canonical);
    expect(verdictFor(host)).not.toBe("allowed");
  });

  // A name merely ending in the same letters is not in the blocked zone.
  it.each([
    ["a name ending in the blocked suffix without its dot", "notlocal"],
    ["a name embedding an internal suffix mid-label", "local.example.test"],
    ["a name embedding the metadata host mid-label", "metadata.google.internal.example.test"],
  ])("allows %s", (_case, host) => {
    expect(verdictFor(host)).toBe("allowed");
  });
});

// The cross-origin strip is asserted from both directions here. The existing tests prove a
// credential is dropped; nothing proved a safe header survives, so emptying the allowlist or
// inverting its test would silently break content negotiation on every redirecting provider.
describe("a cross-origin redirect keeps the headers that carry no credential", () => {
  const followed = async (
    headers: Record<string, string>,
  ): Promise<Headers> => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://other.example.com/thing"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await createGuardedFetch(fetch, { resolveHost: publicResolver })(
      "https://api.example.com/thing",
      { headers },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    return new Headers(fetch.mock.calls[1]?.[1]?.headers);
  };

  it.each([
    ["accept", "application/json"],
    ["accept-charset", "utf-8"],
    ["accept-encoding", "gzip"],
    ["accept-language", "en-GB"],
    ["content-length", "0"],
    ["content-type", "application/json"],
    ["user-agent", "whenever/1.0"],
  ])("keeps %s across the origin change", async (name, value) => {
    expect((await followed({ [name]: value })).get(name)).toBe(value);
  });

  it("keeps a safe header while dropping a credential sent beside it", async () => {
    const second = await followed({
      accept: "application/json",
      authorization: "Bearer secret",
    });

    expect(second.get("accept")).toBe("application/json");
    expect(second.get("authorization")).toBeNull();
  });

  it("drops a header the allowlist does not name even when it carries no secret", async () => {
    expect((await followed({ "x-request-id": "req-1" })).get("x-request-id")).toBeNull();
  });
});

describe("the redirect budget", () => {
  const chainOf = (hops: number): ReturnType<typeof vi.fn<FetchLike>> => {
    const fetch = vi.fn<FetchLike>();
    for (let hop = 0; hop < hops; hop += 1) {
      fetch.mockResolvedValueOnce(
        redirectTo(`https://api.example.com/hop-${String(hop + 1)}`),
      );
    }
    fetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    return fetch;
  };

  // The existing "does not follow forever" tests redirect endlessly, so they refuse whichever
  // side of the bound the comparison falls on. These two name the bound itself.
  it("follows a chain of exactly the redirects it allows", async () => {
    const fetch = chainOf(EGRESS_MAX_REDIRECTS);

    const response = await createGuardedFetch(fetch, {
      resolveHost: publicResolver,
    })("https://api.example.com/start");

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(EGRESS_MAX_REDIRECTS + 1);
  });

  // The code rather than the message: three other refusals in this file also mention redirects,
  // and the code is what a run result is classified by.
  it("refuses one redirect past the budget rather than following it", async () => {
    const fetch = chainOf(EGRESS_MAX_REDIRECTS + 1);

    await expect(
      createGuardedFetch(fetch, { resolveHost: publicResolver })(
        "https://api.example.com/start",
      ),
    ).rejects.toMatchObject({ code: "HTTP_TOO_MANY_REDIRECTS" });
    expect(fetch).toHaveBeenCalledTimes(EGRESS_MAX_REDIRECTS + 1);
  });

  // A redirect naming no target is handed back rather than followed: the guard must not
  // fabricate one from the request it already made.
  it.each([
    ["no Location header at all", undefined],
    ["an empty Location header", ""],
  ])("hands back a redirect carrying %s", async (_case, location) => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      new Response(null, {
        status: 302,
        ...(location === undefined ? {} : { headers: { location } }),
      }),
    );

    const response = await createGuardedFetch(fetch, {
      resolveHost: publicResolver,
    })("https://api.example.com/start");

    expect(response.status).toBe(302);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect naming a target that cannot be read as a url", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValue(redirectTo("http://"));

    await expect(
      createGuardedFetch(fetch, { resolveHost: publicResolver })(
        "https://api.example.com/start",
      ),
    ).rejects.toMatchObject({ code: "HTTP_INVALID_REDIRECT" });
  });

  // The only refusal a GET can draw from the cross-origin body rule, since a write is stopped
  // earlier by the ambiguous-write guard.
  it("refuses to carry a body across an origin change", async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(redirectTo("https://other.example.com/thing"))
      .mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      createGuardedFetch(fetch, { resolveHost: publicResolver })(
        "https://api.example.com/start",
        { body: "carried" },
      ),
    ).rejects.toMatchObject({ code: "HTTP_CROSS_ORIGIN_REDIRECT" });
  });
});

// The shared signal is the operation's whole budget. Its two jobs are to refuse a request whose
// budget has already gone, and to stop a chain mid-flight — neither of which the identity test
// on the signal can see.
describe("the shared deadline bounds the operation, not each hop", () => {
  it("makes no request at all when the shared budget has already elapsed", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const spent = AbortSignal.abort(new Error("budget spent"));

    await expect(
      createGuardedFetch(fetch, {
        resolveHost: publicResolver,
        signal: spent,
      })("https://api.example.com/thing"),
    ).rejects.toThrow("budget spent");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops a redirect chain at the hop after the budget goes", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(async () => {
        controller.abort(new Error("budget spent mid-chain"));
        return await Promise.resolve(
          redirectTo("https://api.example.com/second"),
        );
      })
      .mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      createGuardedFetch(fetch, {
        resolveHost: publicResolver,
        signal: controller.signal,
      })("https://api.example.com/first"),
    ).rejects.toThrow("budget spent mid-chain");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // Three things can stop a hop: the check at the top of the loop, the one closing
  // `cancelRedirectBody`, and the resolution race inside `assertResolvedAddressesAllowed`. Each
  // defends a different path, so each needs a case that reaches it with the others out of the
  // way. `resolveHost` is optional in production — `runtime.ts` returns none off Node — so the
  // loop's own check is the only guard on that path.
  it("makes no request when the budget is spent and no resolver is configured", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      createGuardedFetch(fetch, {
        signal: AbortSignal.abort(new Error("spent before the first hop")),
      })("https://api.example.com/thing"),
    ).rejects.toThrow("spent before the first hop");
    expect(fetch).not.toHaveBeenCalled();
  });

  // Reaches the check closing `cancelRedirectBody`: without it, the hop's unusable Location is
  // reported instead of the budget that had already gone.
  it("reports the spent budget rather than the next hop's own problem", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(async () => {
        controller.abort(new Error("spent mid-chain"));
        return await Promise.resolve(redirectTo("http://"));
      })
      .mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      createGuardedFetch(fetch, { signal: controller.signal })(
        "https://api.example.com/first",
      ),
    ).rejects.toThrow("spent mid-chain");
  });

  it("stops a chain with no resolver at the hop after the budget goes", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<FetchLike>()
      .mockImplementationOnce(async () => {
        controller.abort(new Error("budget spent with no resolver"));
        return await Promise.resolve(
          redirectTo("https://api.example.com/second"),
        );
      })
      .mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      createGuardedFetch(fetch, { signal: controller.signal })(
        "https://api.example.com/first",
      ),
    ).rejects.toThrow("budget spent with no resolver");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("carries the shared reason rather than a timeout of its own", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    const reason = new Error("the operation was cancelled");

    await expect(
      createGuardedFetch(fetch, {
        resolveHost: publicResolver,
        signal: AbortSignal.abort(reason),
      })("https://api.example.com/thing"),
    ).rejects.toBe(reason);
  });
});

// A name is only allowed once the addresses behind it are, so every way that resolution can fail
// has to end in a refusal rather than in a request.
describe("resolving the host before trusting the name", () => {
  const refusalFor = async (
    resolveHost: (hostname: string) => Promise<string[]>,
  ): Promise<{ message: string; called: boolean }> => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));
    try {
      await createGuardedFetch(fetch, { resolveHost })(
        "https://api.example.com/thing",
      );
      return { message: "allowed", called: fetch.mock.calls.length > 0 };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : "unknown",
        called: fetch.mock.calls.length > 0,
      };
    }
  };

  it("refuses a name whose resolution failed", async () => {
    const outcome = await refusalFor(async () => {
      await Promise.resolve();
      throw new Error("ENOTFOUND");
    });

    expect(outcome.message).toContain("could not be resolved");
    expect(outcome.called).toBe(false);
  });

  it("reports a budget spent during resolution as the budget, not as a failed lookup", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await expect(
      createGuardedFetch(fetch, {
        signal: controller.signal,
        resolveHost: async () => {
          controller.abort(new Error("spent during resolution"));
          return await new Promise<string[]>(() => {
            // Never settles: the deadline is what has to end this.
          });
        },
      })("https://api.example.com/thing"),
    ).rejects.toThrow("spent during resolution");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a name that resolved to nothing", async () => {
    const outcome = await refusalFor(async () => await Promise.resolve([]));

    expect(outcome.message).toContain("resolved to no addresses");
    expect(outcome.called).toBe(false);
  });

  it.each([
    ["a loopback address", "127.0.0.1"],
    ["a private address", "10.1.2.3"],
    ["a link-local address", "169.254.169.254"],
    ["a loopback IPv6 address", "::1"],
  ])("refuses a public name that resolved to %s", async (_case, address) => {
    const outcome = await refusalFor(
      async () => await Promise.resolve([address]),
    );

    expect(outcome.message).toContain("private or reserved");
    expect(outcome.called).toBe(false);
  });

  // Every answer has to pass, not just the first: a resolver returning one public and one private
  // address must not be trusted for the public one.
  it("refuses a name whose answers are not all allowed", async () => {
    const outcome = await refusalFor(
      async () => await Promise.resolve(["93.184.216.34", "10.1.2.3"]),
    );

    expect(outcome.message).toContain("private or reserved");
    expect(outcome.called).toBe(false);
  });

  it("does not resolve a target that is already an address", async () => {
    const resolveHost = vi.fn(async () => await Promise.resolve(["10.1.2.3"]));
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await createGuardedFetch(fetch, { resolveHost })("https://93.184.216.34/thing");

    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("does not resolve an IPv6 literal target either", async () => {
    const resolveHost = vi.fn(async () => await Promise.resolve(["10.1.2.3"]));
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ ok: true }));

    await createGuardedFetch(fetch, { resolveHost })(
      "https://[2606:2800:220:1::1]/thing",
    );

    expect(resolveHost).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  createGuardedFetch,
  createMcpDiscoveryFromEnv,
  createWorkflowIntegrationsFromEnv,
  type EgressDestination,
  type FetchLike,
  type RefuseDestination,
} from "../src/index";

const PUBLIC_ADDRESS = "93.184.216.34";
const REFUSED_ADDRESS = "203.0.113.7";

const refusingAddress: RefuseDestination = async ({ addresses }) =>
  await Promise.resolve(
    addresses.includes(REFUSED_ADDRESS) ? "the address is off limits" : undefined,
  );

function answering(): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>(async () => await Promise.resolve(Response.json({ ok: true })));
}

async function refusal(request: Promise<unknown>): Promise<{ message: string; code: unknown }> {
  return await request.then(
    () => {
      throw new Error("the request was expected to be refused");
    },
    (error: unknown) => ({
      message: (error as Error).message,
      code: (error as { code?: unknown }).code,
    }),
  );
}

describe("a destination the caller refuses", () => {
  it("is shown an IP literal host as its only address, without resolving it", async () => {
    const seen: EgressDestination[] = [];
    const resolveHost = vi.fn(async () => await Promise.resolve([PUBLIC_ADDRESS]));

    await createGuardedFetch(answering(), {
      resolveHost,
      refuseDestination: async (destination) => {
        seen.push(destination);
        return await Promise.resolve(undefined);
      },
    })(`https://${PUBLIC_ADDRESS}/thing`);

    expect(seen).toEqual([{ hostname: PUBLIC_ADDRESS, addresses: [PUBLIC_ADDRESS] }]);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("is shown an IPv6 literal without its brackets", async () => {
    const seen: EgressDestination[] = [];

    await createGuardedFetch(answering(), {
      refuseDestination: async (destination) => {
        seen.push(destination);
        return await Promise.resolve(undefined);
      },
    })("https://[2606:2800:220:1::1]/thing");

    expect(seen).toEqual([
      { hostname: "2606:2800:220:1::1", addresses: ["2606:2800:220:1::1"] },
    ]);
  });

  it("is shown what the resolver answered for a name", async () => {
    const seen: EgressDestination[] = [];

    await createGuardedFetch(answering(), {
      resolveHost: async () => await Promise.resolve([PUBLIC_ADDRESS, "2606:2800:220:1::1"]),
      refuseDestination: async (destination) => {
        seen.push(destination);
        return await Promise.resolve(undefined);
      },
    })("https://API.Example.com/thing");

    expect(seen).toEqual([
      { hostname: "api.example.com", addresses: [PUBLIC_ADDRESS, "2606:2800:220:1::1"] },
    ]);
  });

  it("refuses an IP literal with the reason given, before anything is sent", async () => {
    const fetch = answering();

    const outcome = await refusal(
      createGuardedFetch(fetch, { refuseDestination: refusingAddress })(
        `http://${REFUSED_ADDRESS}/health`,
      ),
    );

    expect(outcome).toEqual({
      message: `Request to http://${REFUSED_ADDRESS} is not allowed: the address is off limits`,
      code: "HTTP_EGRESS_BLOCKED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a refused address", async () => {
    const fetch = answering();

    const outcome = await refusal(
      createGuardedFetch(fetch, {
        resolveHost: async () => await Promise.resolve([PUBLIC_ADDRESS, REFUSED_ADDRESS]),
        refuseDestination: refusingAddress,
      })("http://alias.example.com/health"),
    );

    expect(outcome.message).toBe(
      "Request to http://alias.example.com is not allowed: the address is off limits",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a refused IP literal before following it", async () => {
    const fetch = vi.fn<FetchLike>(
      async () =>
        await Promise.resolve(
          new Response(null, { status: 302, headers: { location: `http://${REFUSED_ADDRESS}/` } }),
        ),
    );

    const outcome = await refusal(
      createGuardedFetch(fetch, {
        resolveHost: async () => await Promise.resolve([PUBLIC_ADDRESS]),
        refuseDestination: refusingAddress,
      })("https://start.example.com/hop"),
    );

    expect(outcome.code).toBe("HTTP_EGRESS_BLOCKED");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses when the check itself fails", async () => {
    const fetch = answering();

    const outcome = await refusal(
      createGuardedFetch(fetch, {
        refuseDestination: async () => {
          await Promise.resolve();
          throw new Error("lookup failed");
        },
      })(`https://${PUBLIC_ADDRESS}/thing`),
    );

    expect(outcome).toEqual({
      message: `Request to https://${PUBLIC_ADDRESS} is not allowed: the destination could not be checked`,
      code: "HTTP_EGRESS_BLOCKED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is not consulted for a destination the built-in checks already refuse", async () => {
    const refuseDestination = vi.fn(refusingAddress);

    await refusal(createGuardedFetch(answering(), { refuseDestination })("http://127.0.0.1/"));

    expect(refuseDestination).not.toHaveBeenCalled();
  });
});

describe("a destination refused for the integrations", () => {
  const integrations = (fetch: FetchLike, probeFetch: FetchLike) =>
    createWorkflowIntegrationsFromEnv({
      fetch,
      probeFetch,
      resolveHost: async () => await Promise.resolve([PUBLIC_ADDRESS]),
      refuseDestination: refusingAddress,
    });

  it("is refused for an HTTP request", async () => {
    const fetch = answering();

    const outcome = await refusal(
      integrations(fetch, fetch).http.get({ url: `http://${REFUSED_ADDRESS}/health` }),
    );

    expect(outcome.code).toBe("HTTP_EGRESS_BLOCKED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is refused for an MCP tool call, handshake included", async () => {
    const fetch = answering();
    const probeFetch = answering();

    const outcome = await refusal(
      integrations(fetch, probeFetch).mcp.read({
        url: `https://${REFUSED_ADDRESS}/mcp`,
        toolName: "ping",
      }),
    );

    expect(outcome.code).toBe("HTTP_EGRESS_BLOCKED");
    expect(probeFetch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is refused for an MCP tool listing", async () => {
    const fetch = answering();

    const outcome = await refusal(
      createMcpDiscoveryFromEnv({ fetch, refuseDestination: refusingAddress })({
        url: `https://${REFUSED_ADDRESS}/mcp`,
      }),
    );

    expect(outcome.code).toBe("HTTP_EGRESS_BLOCKED");
    expect(fetch).not.toHaveBeenCalled();
  });
});

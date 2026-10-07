import { NonRetryableError } from "@wix/whenever-workflow-sdk";
import { Agent } from "undici";

import type { FetchLike } from "./http";

export const EGRESS_TIMEOUT_MS = 30_000;
export const EGRESS_MAX_REDIRECTS = 5;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const SAFE_METHODS = new Set(["GET", "HEAD"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

function blocked(url: URL, detail: string): NonRetryableError {
  return new NonRetryableError(
    `Request to ${url.protocol}//${url.host} is not allowed: ${detail}`,
    { code: "HTTP_EGRESS_BLOCKED" },
  );
}

function parseIpv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function isBlockedIpv4(value: number): boolean {
  const inRange = (prefix: string, bits: number): boolean => {
    const base = parseIpv4(prefix);
    if (base === undefined) return false;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (base & mask) >>> 0;
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) ||
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.0.0.0", 24) ||
    inRange("192.168.0.0", 16) ||
    inRange("198.18.0.0", 15) ||
    inRange("224.0.0.0", 4) ||
    inRange("240.0.0.0", 4)
  );
}

function expandIpv6(host: string): number[] | undefined {
  const trailingV4 = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
  let text = host;
  let tail: number[] = [];
  if (trailingV4?.[1] !== undefined && trailingV4[2] !== undefined) {
    const embedded = parseIpv4(trailingV4[2]);
    if (embedded === undefined) return undefined;
    text = trailingV4[1].replace(/:$/, "");
    tail = [(embedded >>> 16) & 0xffff, embedded & 0xffff];
    if (text === "") text = ":";
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string): number[] | undefined => {
    if (part === "" || part === ":") return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (chunk === "") continue;
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return undefined;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  if (head === undefined || rest === undefined) return undefined;

  const known = [...head, ...rest, ...tail];
  if (halves.length === 2) {
    const fill = 8 - known.length;
    if (fill < 0) return undefined;
    return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
  }
  return known.length === 8 ? known : undefined;
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embeddedIpv4 = (high: number, low: number): number =>
    ((high << 16) >>> 0) + low;
  const wellKnownNat64 =
    g0 === 0x64 &&
    g1 === 0xff9b &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0;
  if (wellKnownNat64) return isBlockedIpv4(embeddedIpv4(g6, g7));
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) {
    const globallyReachableAnycast =
      g1 === 1 &&
      g2 === 0 &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0 &&
      g6 === 0 &&
      (g7 === 1 || g7 === 2 || g7 === 3);
    const amt = g1 === 3;
    const as112 = g1 === 4 && g2 === 0x112;
    return !globallyReachableAnycast && !amt && !as112;
  }
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  if (g0 === 0x2002) return true;
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true;
  return false;
}

export function assertAllowedEgressUrl(url: URL): void {
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw blocked(url, `the ${url.protocol} scheme is not allowed, use http: or https:`);
  }

  const hostname = url.hostname.toLowerCase();
  const bracketless = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname.replace(/\.+$/u, "");

  if (bracketless.includes(":")) {
    const groups = expandIpv6(bracketless);
    if (groups === undefined) throw blocked(url, "the host is not a routable address");
    if (isBlockedIpv6(groups)) throw blocked(url, "it resolves to a private or reserved address");
    return;
  }

  const ipv4 = parseIpv4(bracketless);
  if (ipv4 !== undefined) {
    if (isBlockedIpv4(ipv4)) throw blocked(url, "it resolves to a private or reserved address");
    return;
  }

  if (BLOCKED_HOSTNAMES.has(bracketless)) {
    throw blocked(url, "the host names an internal service");
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (bracketless.endsWith(suffix)) {
      throw blocked(url, "the host names an internal service");
    }
  }
}

const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  "accept",
  "accept-charset",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "user-agent",
]);

export type ResolveHost = (hostname: string) => Promise<string[]>;

function stripCredentials(headers: Headers): Headers {
  const retained = new Headers();
  headers.forEach((value, name) => {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) {
      retained.set(name, value);
    }
  });
  return retained;
}

function isIpLiteral(hostname: string): boolean {
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return bare.includes(":") || parseIpv4(bare) !== undefined;
}

function abortedBefore(deadline: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (deadline.aborted) {
      reject(deadline.reason as Error);
      return;
    }
    deadline.addEventListener(
      "abort",
      () => reject(deadline.reason as Error),
      { once: true },
    );
  });
}

async function assertResolvedAddressesAllowed(
  url: URL,
  resolveHost: ResolveHost | undefined,
  deadline: AbortSignal,
): Promise<readonly string[] | undefined> {
  const hostname = url.hostname.toLowerCase();
  if (resolveHost === undefined || isIpLiteral(hostname)) return undefined;

  let addresses: string[];
  try {
    addresses = await Promise.race([
      resolveHost(hostname),
      abortedBefore(deadline),
    ]);
  } catch (caught) {
    if (deadline.aborted) throw caught;
    throw blocked(url, "the host could not be resolved");
  }
  if (addresses.length === 0) {
    throw blocked(url, "the host resolved to no addresses");
  }
  for (const address of addresses) {
    const probe = new URL(url.toString());
    probe.hostname = address.includes(":") ? `[${address}]` : address;
    assertAllowedEgressUrl(probe);
  }
  return addresses;
}

interface PinnedLookupOptions {
  readonly all?: boolean;
  readonly family?: number | "IPv4" | "IPv6";
}

type PinnedLookupCallback = (
  error: Error | null,
  address: string | PinnedAddress[],
  family?: number,
) => void;

interface PinnedAddress {
  address: string;
  family: number;
}

export type PinnedLookup = (
  hostname: string,
  options: PinnedLookupOptions,
  callback: PinnedLookupCallback,
) => void;

function requestedFamily(
  family: PinnedLookupOptions["family"],
): 4 | 6 | undefined {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return undefined;
}

// The socket layer would otherwise resolve the hostname a second time, so a
// rebinding answer could replace the address this guard already vetted.
export function pinnedAddressLookup(
  addresses: readonly string[],
): PinnedLookup {
  const pinned: PinnedAddress[] = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));

  return (_hostname, options, callback) => {
    const family = requestedFamily(options.family);
    const requested =
      family === undefined
        ? pinned
        : pinned.filter((entry) => entry.family === family);
    const [first] = requested;
    if (first === undefined) {
      callback(new Error("No vetted address matches the requested family."), []);
      return;
    }
    if (options.all === true) {
      callback(null, requested);
      return;
    }
    callback(null, first.address, first.family);
  };
}

function withPinnedAddresses(
  init: RequestInit,
  addresses: readonly string[],
): RequestInit {
  return {
    ...init,
    dispatcher: new Agent({
      connect: { lookup: pinnedAddressLookup(addresses) },
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
    }),
  } as RequestInit;
}

export interface GuardedFetchOptions {
  timeoutMs?: number;
  resolveHost?: ResolveHost;
  /** Shared across every request this fetch makes: the per-request timeout restarts
   * on each call, so a two-hop operation would otherwise get the window twice. */
  signal?: AbortSignal;
}

function invocationDeadline(
  timeoutMs: number,
  shared: AbortSignal | undefined,
): AbortSignal {
  const perRequest = AbortSignal.timeout(timeoutMs);
  if (shared === undefined) return perRequest;
  const controller = new AbortController();
  const abort = (reason: unknown): void => {
    controller.abort(reason);
  };
  if (shared.aborted) abort(shared.reason);
  else if (perRequest.aborted) abort(perRequest.reason);
  else {
    shared.addEventListener("abort", () => {
      abort(shared.reason);
    });
    perRequest.addEventListener("abort", () => {
      abort(perRequest.reason);
    });
  }
  return controller.signal;
}

async function cancelRedirectBody(
  response: Response,
  deadline: AbortSignal,
): Promise<void> {
  if (response.body !== null) {
    await Promise.race([
      response.body.cancel(),
      abortedBefore(deadline),
    ]);
  }
  deadline.throwIfAborted();
}

export function createGuardedFetch(
  fetchImplementation: FetchLike,
  options: GuardedFetchOptions = {},
): FetchLike {
  const timeoutMs = options.timeoutMs ?? EGRESS_TIMEOUT_MS;

  return async (input, init) => {
    let url = input instanceof URL ? input : new URL(String(input));
    let method = init?.method ?? "GET";
    let body = init?.body;
    let headers = new Headers(init?.headers);
    const deadline = invocationDeadline(timeoutMs, options.signal);

    for (let hop = 0; hop <= EGRESS_MAX_REDIRECTS; hop += 1) {
      deadline.throwIfAborted();
      assertAllowedEgressUrl(url);
      const pinned = await assertResolvedAddressesAllowed(
        url,
        options.resolveHost,
        deadline,
      );

      const hopInit: RequestInit = {
        ...init,
        method,
        headers,
        ...(body === undefined ? { body: undefined } : { body }),
        redirect: "manual",
        signal: deadline,
      };
      const response = await fetchImplementation(
        url,
        pinned === undefined ? hopInit : withPinnedAddresses(hopInit, pinned),
      );
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      if (!SAFE_METHODS.has(method.toUpperCase())) {
        try {
          await response.body?.cancel();
        } catch {
          // Cleanup cannot replace the evidence classification for the write.
        }
        throw new NonRetryableError(
          `External write received redirect status ${String(response.status)} and will not be replayed or rewritten.`,
          { code: "AMBIGUOUS_EXTERNAL_WRITE" },
        );
      }

      const location = response.headers.get("location");
      if (location === null || location === "") return response;
      await cancelRedirectBody(response, deadline);

      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        throw new NonRetryableError(
          `Redirect from ${url.protocol}//${url.host} names a target that is not a usable url`,
          { code: "HTTP_INVALID_REDIRECT" },
        );
      }
      const upgraded = method.toUpperCase();
      const rewritesToGet =
        ((response.status === 301 || response.status === 302) &&
          upgraded === "POST") ||
        (response.status === 303 && upgraded !== "GET" && upgraded !== "HEAD");
      if (target.origin !== url.origin) {
        if (body !== undefined && !rewritesToGet) {
          throw new NonRetryableError(
            `Redirect from ${url.protocol}//${url.host} to ${target.protocol}//${target.host} would carry the request body to another origin`,
            { code: "HTTP_CROSS_ORIGIN_REDIRECT" },
          );
        }
        headers = stripCredentials(headers);
      }
      if (rewritesToGet) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
        headers.delete("content-length");
      }
      url = target;
    }

    throw new NonRetryableError(
      `Request exceeded ${String(EGRESS_MAX_REDIRECTS)} redirects`,
      { code: "HTTP_TOO_MANY_REDIRECTS" },
    );
  };
}

import * as http from "node:http";
import * as https from "node:https";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as Array<[string, number]>) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::", 96], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
  ["2001::", 32], ["2002::", 16], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
] as Array<[string, number]>) blocked.addSubnet(address, prefix, "ipv6");

export interface ResolvedAddress { address: string; family: 4 | 6 }

/** Node's BlockList represents IPv4 inside its IPv6 table, so mapped forms are normalized first. */
function mappedIPv4(address: string): string | undefined {
  const value = address.toLowerCase();
  if (isIP(value) !== 6) return undefined;
  if (value.startsWith("::ffff:")) {
    const rest = value.slice(7);
    if (isIP(rest) === 4) return rest;
  }
  const groups = value.split(":");
  if (groups.length >= 3 && groups[groups.length - 3] === "ffff") {
    const high = Number.parseInt(groups[groups.length - 2] || "", 16);
    const low = Number.parseInt(groups[groups.length - 1] || "", 16);
    if (Number.isFinite(high) && Number.isFinite(low)) return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return undefined;
}

/** True only for globally routable addresses. */
export function isPublicAddress(address: string): boolean {
  const mapped = mappedIPv4(address);
  if (mapped) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  try { return !blocked.check(address, family === 4 ? "ipv4" : "ipv6"); }
  catch { return false; }
}

/** Resolve once, validate every answer, and return the address the request must connect to. */
export async function resolvePublicAddress(hostname: string): Promise<ResolvedAddress> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    const normalized = mappedIPv4(literal) || literal;
    if (!isPublicAddress(normalized)) throw new Error("private or local addresses are refused");
    return { address: normalized, family: isIP(normalized) as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  for (const entry of addresses) {
    const normalized = mappedIPv4(entry.address) || entry.address;
    if (isPublicAddress(normalized)) return { address: normalized, family: isIP(normalized) as 4 | 6 };
  }
  throw new Error("private or local addresses are refused");
}

/** Node's request lookup hook: return the already-validated address instead of resolving again. */
export function createPinnedLookup(target: ResolvedAddress): (hostname: string, options: unknown, callback?: (...args: unknown[]) => void) => void {
  return (hostname, options, callback) => {
    const done = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const settings = typeof options === "object" && options ? options as { all?: boolean } : {};
    if (settings.all) done(null, [{ address: target.address, family: target.family }]);
    else done(null, target.address, target.family);
  };
}

export interface PageResult { status: number; contentType: string; text: string; truncated: boolean }
export interface PageOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }

/**
 * Fetch a public page over a connection pinned to the validated DNS answer.
 * Redirects are not followed. TLS still verifies the hostname via SNI.
 */
export function requestPublicPage(input: URL, options: PageOptions = {}): Promise<PageResult> {
  return new Promise((resolve, reject) => {
    if (!["http:", "https:"].includes(input.protocol) || input.username || input.password) {
      reject(new Error("only credential-free HTTP(S) URLs are allowed"));
      return;
    }
    const hostname = input.hostname.replace(/^\[|\]$/g, "");
    const maxBytes = Math.max(1, options.maxBytes ?? 80_000);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 20_000);
    withDeadline(resolvePublicAddress(hostname), timeoutMs, options.signal).then((target) => {
      const client = input.protocol === "https:" ? https : http;
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestOptions: Record<string, unknown> = {
        hostname,
        port: input.port || undefined,
        path: `${input.pathname}${input.search}`,
        method: "GET",
        headers: { "user-agent": "CenmaxAI-VSCode/0.1", accept: "*/*" },
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        lookup: createPinnedLookup(target),
      };
      if (input.protocol === "https:") requestOptions.servername = hostname;
      const request = client.request(requestOptions as http.RequestOptions, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on("data", (chunk: Buffer) => {
          if (size >= maxBytes) { truncated = true; return; }
          const take = chunk.subarray(0, maxBytes - size);
          chunks.push(take);
          size += take.length;
          if (take.length < chunk.length) truncated = true;
        });
        response.on("end", () => resolve({
          status: response.statusCode || 0,
          contentType: String(response.headers["content-type"] || ""),
          text: Buffer.concat(chunks).toString("utf8"),
          truncated,
        }));
        response.on("error", reject);
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("The request timed out.")));
      request.on("error", reject);
      request.end();
    }, reject);
  });
}


function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("The request timed out.")));
    const timer = setTimeout(() => finish(() => reject(new Error("The request timed out."))), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}

export const DEFAULT_GATEWAY = "https://console.ai.cenmax.in";
export const DEFAULT_API_BASE = "https://api.ai.cenmax.in/v1";

const TRUSTED_HOSTS = new Set(["console.ai.cenmax.in", "api.ai.cenmax.in", "localhost", "127.0.0.1", "::1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** User/application-scoped settings only. A workspace must never be able to point tokens at another host. */
export function safeGatewayUrl(value         )         {
  return safeEndpoint(value, DEFAULT_GATEWAY, true) || DEFAULT_GATEWAY;
}

export function safeApiBaseUrl(value         )         {
  return safeEndpoint(value, DEFAULT_API_BASE, false) || DEFAULT_API_BASE;
}

function safeEndpoint(value         , fallback        , originOnly         )                     {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return undefined;
    if (!TRUSTED_HOSTS.has(url.hostname.toLowerCase())) return undefined;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))) return undefined;
    if (originOnly) return url.origin;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

/** The device-flow page must belong to the configured gateway origin (or localhost during development). */
export function isSafeVerificationUrl(value        , origin        )          {
  try {
    const target = new URL(value);
    const base = new URL(origin);
    if (target.username || target.password) return false;
    if (!["http:", "https:"].includes(target.protocol)) return false;
    if (target.protocol === "http:" && !LOOPBACK_HOSTS.has(target.hostname.toLowerCase())) return false;
    const host = target.hostname.toLowerCase();
    if (host === base.hostname.toLowerCase() || TRUSTED_HOSTS.has(host)) return true;
    return LOOPBACK_HOSTS.has(host) && LOOPBACK_HOSTS.has(base.hostname.toLowerCase());
  } catch {
    return false;
  }
}


//# sourceURL=../src/endpoints.ts
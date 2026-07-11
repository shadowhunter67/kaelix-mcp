export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlValidationError";
  }
}

/**
 * Loopback hosts are allowed over plain HTTP because that is the default
 * local-development target (KAELIX_API_URL=http://localhost:8000/api).
 * Everything else must be HTTPS. This intentionally does not attempt to
 * resolve DNS (no network call during validation) — it only recognizes
 * literal loopback forms, including the IPv4-mapped IPv6 form, so callers
 * cannot bypass the loopback allowance by writing it differently.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (/^127(\.\d{1,3}){3}$/.test(h)) return true; // entire 127.0.0.0/8
  if (h === "::1" || h === "[::1]") return true;
  if (h === "::ffff:127.0.0.1" || h === "0:0:0:0:0:ffff:127.0.0.1") return true;
  return false;
}

export interface UrlGuardOptions {
  /** Optional explicit allowlist of hostnames for non-loopback targets. */
  allowedHosts?: string[];
}

/**
 * Validates a Kaelix API base URL (or a redirect target) against the adapter's
 * SSRF/trust-boundary rules:
 *  - http/https only
 *  - no embedded userinfo (user:pass@host)
 *  - http only for loopback hosts; everything else must be https
 *  - if an allowlist is configured, non-loopback hosts must be on it
 */
export function validateApiUrl(raw: string, options: UrlGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlValidationError(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlValidationError(`Unsupported protocol "${url.protocol}" in URL: ${raw}`);
  }

  if (url.username || url.password) {
    throw new UrlValidationError("URL must not contain embedded credentials (user:pass@host).");
  }

  const loopback = isLoopbackHostname(url.hostname);

  if (url.protocol === "http:" && !loopback) {
    throw new UrlValidationError(
      `Refusing plain HTTP for non-loopback host "${url.hostname}". Use HTTPS or a loopback address.`,
    );
  }

  if (!loopback && options.allowedHosts && options.allowedHosts.length > 0) {
    const normalized = normalizeHostname(url.hostname);
    const allowed = options.allowedHosts.some((h) => normalizeHostname(h) === normalized);
    if (!allowed) {
      throw new UrlValidationError(
        `Host "${url.hostname}" is not in KAELIX_ALLOWED_HOSTS. Add it explicitly to allow this target.`,
      );
    }
  }

  return url;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

export function parseAllowedHosts(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const hosts = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

export function sameOrigin(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    (a.port || defaultPort(a)) === (b.port || defaultPort(b))
  );
}

function defaultPort(url: URL): string {
  return url.protocol === "https:" ? "443" : "80";
}

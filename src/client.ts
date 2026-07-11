import { loadConfig, type KaelixConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import { sameOrigin, validateApiUrl } from "./url-guard.js";

export type AuthMode = "bearer" | "cookie" | "none";

export type ErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation"
  | "timeout"
  | "rate_limit"
  | "network"
  | "backend"
  | "parse"
  | "response_too_large"
  | "capability_unavailable"
  | "unexpected";

export interface KaelixClientOptions {
  baseUrl: string;
  apiToken?: string;
  sessionCookie?: string;
  allowCookieAuth?: boolean;
  timeoutMs?: number;
  allowedHosts?: string[];
  fetchImpl?: typeof fetch;
  /** Max response body bytes read into memory. Defaults to 2 MiB. */
  maxResponseBytes?: number;
}

export class KaelixApiError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly path: string;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: { kind: ErrorKind; path: string; status?: number; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "KaelixApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.path = options.path;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 1;
const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);
const MAX_RETRY_ATTEMPTS = 2; // total attempts, not additional retries
const MAX_RETRY_AFTER_WAIT_MS = 5_000;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

export class KaelixClient {
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  private readonly baseUrlObj: URL;
  private readonly apiToken?: string;
  private readonly sessionCookie?: string;
  private readonly allowedHosts?: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(options: KaelixClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.allowedHosts = options.allowedHosts;
    this.baseUrlObj = validateApiUrl(this.baseUrl, { allowedHosts: this.allowedHosts });
    this.apiToken = options.apiToken;
    // Bearer and cookie auth are mutually exclusive: if a token is configured,
    // the cookie is never attached, even if one was supplied. This avoids
    // sending a stale/local-dev session credential alongside production auth.
    this.sessionCookie = !options.apiToken && options.allowCookieAuth ? options.sessionCookie : undefined;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authMode = this.apiToken ? "bearer" : this.sessionCookie ? "cookie" : "none";
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const retryable = RETRYABLE_METHODS.has(method);
    const maxAttempts = retryable ? MAX_RETRY_ATTEMPTS : 1;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.attempt<T>(path, init);
      } catch (error) {
        lastError = error;
        if (!retryable || attempt >= maxAttempts || !this.isRetryable(error)) {
          throw error;
        }
        const waitMs = this.retryDelayMs(error, attempt);
        if (waitMs > 0) await sleep(waitMs);
      }
    }
    throw lastError;
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof KaelixApiError)) return false;
    return error.kind === "network" || error.kind === "rate_limit" || (error.status ?? 0) >= 500;
  }

  private retryDelayMs(error: unknown, attempt: number): number {
    if (error instanceof KaelixApiError && error.retryAfterSeconds !== undefined) {
      return Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_WAIT_MS);
    }
    return Math.min(100 * 2 ** attempt, 1000);
  }

  private async attempt<T>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let targetUrl = new URL(`${this.baseUrl}${path}`);
      let headers = this.buildHeaders(init, this.baseUrlObj, targetUrl);
      let requestInit: RequestInit = { ...init, headers, signal: controller.signal, redirect: "manual" };
      let res = await this.fetchImpl(targetUrl.toString(), requestInit);

      let redirects = 0;
      while (isRedirect(res.status) && redirects < MAX_REDIRECTS) {
        const location = res.headers.get("Location");
        if (!location) break;
        const nextUrl = validateApiUrl(new URL(location, targetUrl).toString(), {
          allowedHosts: this.allowedHosts,
        });
        const crossOrigin = !sameOrigin(nextUrl, this.baseUrlObj);
        headers = this.buildHeaders(init, this.baseUrlObj, nextUrl, crossOrigin);
        const preserveMethod = res.status === 307 || res.status === 308;
        requestInit = {
          ...init,
          method: preserveMethod ? requestInit.method : "GET",
          body: preserveMethod ? init.body : undefined,
          headers,
          signal: controller.signal,
          redirect: "manual",
        };
        targetUrl = nextUrl;
        res = await this.fetchImpl(targetUrl.toString(), requestInit);
        redirects++;
      }

      return await this.readResponse<T>(res, path);
    } catch (error) {
      if (error instanceof KaelixApiError) throw error;
      const isAbort = error instanceof Error && error.name === "AbortError";
      throw new KaelixApiError(
        isAbort
          ? `Kaelix API request timed out after ${this.timeoutMs}ms.`
          : "Could not reach Kaelix API. Check KAELIX_API_URL and backend status.",
        { kind: isAbort ? "timeout" : "network", path },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private buildHeaders(
    init: RequestInit,
    requestOrigin: URL,
    targetUrl: URL,
    forceStripAuth = false,
  ): Headers {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }
    const crossOrigin = forceStripAuth || !sameOrigin(targetUrl, requestOrigin);
    if (!crossOrigin) {
      if (this.apiToken) headers.set("Authorization", `Bearer ${this.apiToken}`);
      if (this.sessionCookie) headers.set("Cookie", this.sessionCookie);
    } else {
      headers.delete("Authorization");
      headers.delete("Cookie");
    }
    return headers;
  }

  private async readResponse<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      const body = await this.safeReadBody(res);
      throw new KaelixApiError(formatHttpError(res, body), {
        kind: classifyStatus(res.status),
        path,
        status: res.status,
        retryAfterSeconds: parseRetryAfter(res.headers.get("Retry-After")),
      });
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const body = await this.safeReadBody(res);
    if (!body.text) return undefined as T;
    try {
      return JSON.parse(body.text) as T;
    } catch {
      throw new KaelixApiError("Kaelix API returned a non-JSON response.", {
        kind: "parse",
        path,
        status: res.status,
      });
    }
  }

  private async safeReadBody(res: Response): Promise<{ text: string; truncated: boolean }> {
    try {
      const text = await res.text();
      if (text.length > this.maxResponseBytes) {
        // Oversized bodies are surfaced as a dedicated error kind rather than
        // silently truncated JSON, which would otherwise fail to parse anyway.
        throw new KaelixApiError(`Kaelix API response exceeded ${this.maxResponseBytes} bytes.`, {
          kind: "response_too_large",
          path: res.url,
          status: res.status,
        });
      }
      return { text, truncated: false };
    } catch (error) {
      if (error instanceof KaelixApiError) throw error;
      return { text: "", truncated: false };
    }
  }
}

export function createClientFromEnv(): KaelixClient {
  const config = loadConfig();
  warnIfCookieAuthEnabled(config);

  return new KaelixClient({
    baseUrl: config.apiUrl,
    apiToken: config.apiToken,
    sessionCookie: config.sessionCookie,
    allowCookieAuth: config.allowCookieAuth,
    timeoutMs: config.timeoutMs,
    allowedHosts: config.allowedHosts,
  });
}

function warnIfCookieAuthEnabled(config: KaelixConfig): void {
  if (config.allowCookieAuth && config.sessionCookie && !config.apiToken) {
    console.warn(
      [
        "KAELIX_ALLOW_COOKIE_AUTH=true is enabled.",
        "Cookie auth is intended for local development only.",
        "Prefer KAELIX_API_TOKEN for shared, remote, or production MCP use.",
      ].join(" "),
    );
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function classifyStatus(status: number): ErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "validation";
  if (status === 429) return "rate_limit";
  return "backend";
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

function formatHttpError(res: Response, body: { text: string }): string {
  const base = `Kaelix API returned ${res.status} ${res.statusText || ""}`.trim();
  const detail = redactSecrets(extractDetail(body.text));
  return detail ? `${base}: ${detail}` : `${base}.`;
}

function extractDetail(body: string): string {
  if (!body) return "";
  try {
    const data = JSON.parse(body) as { detail?: unknown; message?: unknown; error?: unknown };
    const detail = data.detail ?? data.message ?? data.error;
    if (typeof detail === "string") return detail;
    if (detail !== undefined) return JSON.stringify(detail);
  } catch {
    // Fall through to sanitized text.
  }
  return body.slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

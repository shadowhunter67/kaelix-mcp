export type AuthMode = "bearer" | "cookie" | "none";
export type ErrorKind = "auth" | "not_found" | "validation" | "timeout" | "network" | "backend" | "parse";

export interface KaelixClientOptions {
  baseUrl: string;
  apiToken?: string;
  sessionCookie?: string;
  allowCookieAuth?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class KaelixApiError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;
  readonly path: string;

  constructor(message: string, options: { kind: ErrorKind; path: string; status?: number }) {
    super(message);
    this.name = "KaelixApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.path = options.path;
  }
}

export class KaelixClient {
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  readonly timeoutMs: number;
  private readonly apiToken?: string;
  private readonly sessionCookie?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KaelixClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiToken = options.apiToken;
    this.sessionCookie = options.allowCookieAuth ? options.sessionCookie : undefined;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.authMode = this.apiToken ? "bearer" : this.sessionCookie ? "cookie" : "none";
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body) {
      headers.set("Content-Type", "application/json");
    }
    if (this.apiToken) {
      headers.set("Authorization", `Bearer ${this.apiToken}`);
    }
    if (this.sessionCookie) {
      headers.set("Cookie", this.sessionCookie);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      throw new KaelixApiError(
        isAbort
          ? `Kaelix API request timed out after ${this.timeoutMs}ms.`
          : `Could not reach Kaelix API. Check KAELIX_API_URL and backend status.`,
        { kind: isAbort ? "timeout" : "network", path },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await safeReadText(res);
      throw new KaelixApiError(formatHttpError(res, body), {
        kind: classifyStatus(res.status),
        path,
        status: res.status,
      });
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await safeReadText(res);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new KaelixApiError("Kaelix API returned a non-JSON response.", {
        kind: "parse",
        path,
        status: res.status,
      });
    }
  }
}

export function createClientFromEnv(): KaelixClient {
  return new KaelixClient({
    baseUrl: process.env.KAELIX_API_URL || "http://localhost:8000/api",
    apiToken: process.env.KAELIX_API_TOKEN,
    sessionCookie: process.env.KAELIX_SESSION_COOKIE,
    allowCookieAuth: process.env.KAELIX_ALLOW_COOKIE_AUTH === "true",
    timeoutMs: Number(process.env.KAELIX_TIMEOUT_MS || 20_000),
  });
}

function classifyStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400 || status === 409 || status === 422) return "validation";
  return "backend";
}

function formatHttpError(res: Response, body: string): string {
  const base = `Kaelix API returned ${res.status} ${res.statusText || ""}`.trim();
  const detail = extractDetail(body);
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

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

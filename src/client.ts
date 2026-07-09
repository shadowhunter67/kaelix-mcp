export type AuthMode = "bearer" | "cookie" | "none";

export interface KaelixClientOptions {
  baseUrl: string;
  apiToken?: string;
  sessionCookie?: string;
}

export class KaelixClient {
  readonly baseUrl: string;
  readonly authMode: AuthMode;
  private readonly apiToken?: string;
  private readonly sessionCookie?: string;

  constructor(options: KaelixClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiToken = options.apiToken;
    this.sessionCookie = options.sessionCookie;
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

    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kaelix API ${res.status} ${res.statusText}: ${text || "(empty response)"}`);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export function createClientFromEnv(): KaelixClient {
  return new KaelixClient({
    baseUrl: process.env.KAELIX_API_URL || "http://localhost:8000/api",
    apiToken: process.env.KAELIX_API_TOKEN,
    sessionCookie: process.env.KAELIX_SESSION_COOKIE,
  });
}


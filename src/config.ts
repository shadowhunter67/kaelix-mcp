import { parseAllowedHosts, validateApiUrl } from "./url-guard.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Parses KAELIX_TIMEOUT_MS strictly: only a bare non-negative integer string
 * in [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] is accepted. Anything else (missing,
 * blank, decimals, "abc", negative, 0, out of range) fails fast with a clear
 * ConfigError instead of silently coercing to NaN/0/Infinity like `Number()`.
 */
export function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ConfigError(
      `KAELIX_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got "${raw}").`,
    );
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `KAELIX_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (got "${raw}").`,
    );
  }
  return value;
}

export interface KaelixConfig {
  apiUrl: string;
  apiToken?: string;
  allowCookieAuth: boolean;
  sessionCookie?: string;
  timeoutMs: number;
  allowedHosts?: string[];
  enableLocalAiTools: "auto" | "on" | "off";
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

function parseBoolEnv(raw: string | undefined): boolean {
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}

function parseLocalAiFlag(raw: string | undefined): "auto" | "on" | "off" {
  const value = raw?.trim().toLowerCase();
  if (value === "true" || value === "on" || value === "1") return "on";
  if (value === "false" || value === "off" || value === "0") return "off";
  return "auto";
}

/**
 * Reads and validates the adapter's configuration from process.env.
 * Fails fast (throws ConfigError / UrlValidationError) on startup rather than
 * limping along with an unsafe or ambiguous configuration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): KaelixConfig {
  const apiUrl = env.KAELIX_API_URL || "http://localhost:8000/api";
  const allowedHosts = parseAllowedHosts(env.KAELIX_ALLOWED_HOSTS);

  // Validate eagerly so misconfiguration is caught at startup, not on first tool call.
  validateApiUrl(apiUrl, { allowedHosts });

  const allowCookieAuth = parseBoolEnv(env.KAELIX_ALLOW_COOKIE_AUTH);
  const rawSessionCookie = env.KAELIX_SESSION_COOKIE;

  if (allowCookieAuth && !rawSessionCookie) {
    throw new ConfigError("KAELIX_ALLOW_COOKIE_AUTH=true requires KAELIX_SESSION_COOKIE to also be set.");
  }
  if (!allowCookieAuth && rawSessionCookie) {
    // Not fatal: the cookie is simply ignored (opt-in gate), matching README/SECURITY.md.
    // A warning is emitted by the caller (see client.ts) so this stays log-free here.
  }

  return {
    apiUrl,
    apiToken: env.KAELIX_API_TOKEN || undefined,
    allowCookieAuth,
    sessionCookie: allowCookieAuth ? rawSessionCookie : undefined,
    timeoutMs: parseTimeoutMs(env.KAELIX_TIMEOUT_MS),
    allowedHosts,
    enableLocalAiTools: parseLocalAiFlag(env.KAELIX_ENABLE_LOCAL_AI_TOOLS),
  };
}

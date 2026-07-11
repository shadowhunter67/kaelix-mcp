const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /Authorization:\s*\S+/gi,
  /Cookie:\s*\S+/gi,
  /kaelix_session=[^\s;"']+/gi,
  /(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
];

const REDACTED = "[redacted]";

/**
 * Strips known secret shapes (bearer tokens, cookie headers, key=value secrets)
 * from arbitrary text before it can reach logs, tool output, or error messages.
 * Defense in depth: callers should also avoid echoing raw config/headers at all.
 */
export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Redacts secret-shaped strings inside arbitrary JSON-able values, recursively. */
export function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(val, seen);
      }
    }
    return out;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /(token|secret|password|cookie|authorization|api[_-]?key)/i.test(key);
}

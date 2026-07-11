// Minimal, self-contained loopback HTTP server for adapter contract tests.
// No database, no external process, no network access beyond 127.0.0.1, no
// reference to any private backend implementation — this only speaks the
// adapter's public HTTP contract (paths/status codes/headers), the same
// contract src/schemas.ts validates against.
import { createServer } from "node:http";

/**
 * Starts a loopback-only HTTP server on a random free port and returns its
 * base URL plus an async close(). Never binds 0.0.0.0 — always 127.0.0.1.
 */
export function startMockServer(requestListener) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          requestListener(req, res, body);
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(
            JSON.stringify({
              detail: `mock server handler threw: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

/** Redacts a header value for diagnostic/log text — never print raw tokens/cookies. */
export function redactHeaderForLog(value) {
  if (!value) return value;
  return /^bearer\s|session|cookie/i.test(value) ? "[redacted]" : value;
}

/**
 * Records every request this server receives (method, pathname, query,
 * parsed headers, body) for assertions. `summary()` returns a redacted view
 * safe to embed in assertion failure messages.
 */
export function createRecorder() {
  const entries = [];
  return {
    push(entry) {
      entries.push(entry);
    },
    get count() {
      return entries.length;
    },
    all() {
      return entries;
    },
    last() {
      return entries[entries.length - 1];
    },
    summary() {
      return entries.map((e) => ({
        method: e.method,
        path: e.path,
        authorization: e.headers.authorization ? redactHeaderForLog(e.headers.authorization) : undefined,
        cookie: e.headers.cookie ? redactHeaderForLog(e.headers.cookie) : undefined,
      }));
    },
  };
}

export function recordRequest(recorder, req, body) {
  const url = new URL(req.url, "http://127.0.0.1");
  const entry = {
    method: req.method,
    path: url.pathname,
    search: url.search,
    headers: { ...req.headers },
    body,
  };
  recorder.push(entry);
  return entry;
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(text);
}

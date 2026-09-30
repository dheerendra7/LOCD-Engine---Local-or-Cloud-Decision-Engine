import { randomUUID } from "node:crypto";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-locd-api-key",
  "idempotency-key",
  "apiKey",
  "api_key",
  "secret",
  "token",
  "password"
]);

function sanitize(value, depth = 0) {
  if (depth > 3) return "[truncated]";

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(item => sanitize(item, depth + 1));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value).slice(0, 50)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        output[key] = "[redacted]";
      } else {
        output[key] = sanitize(nested, depth + 1);
      }
    }
    return output;
  }

  if (typeof value === "string" && value.length > 1000) {
    return value.slice(0, 1000) + "…";
  }

  return value;
}

export function createLogger({ level = "info", sink = console.log, clock = () => new Date() } = {}) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const configured = levels[level] ?? levels.info;

  function write(eventLevel, event) {
    if (levels[eventLevel] > configured) return;

    const date = typeof clock === "function" ? clock() : new Date(clock);
    const timestamp = date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString()
      : new Date().toISOString();

    sink(JSON.stringify(sanitize({
      timestamp,
      ...event
    })));
  }

  return {
    error(event) {
      write("error", { level: "error", ...event });
    },
    warn(event) {
      write("warn", { level: "warn", ...event });
    },
    info(event) {
      write("info", { level: "info", ...event });
    },
    debug(event) {
      write("debug", { level: "debug", ...event });
    }
  };
}

export function createRequestId(value) {
  const supplied = String(value || "").trim();
  return supplied && supplied.length <= 128 ? supplied : randomUUID();
}

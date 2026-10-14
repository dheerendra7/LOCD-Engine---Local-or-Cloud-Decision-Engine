export function createRateLimiter({ maxRequests = 0, windowMs = 60_000 } = {}) {
  const limit = Number(maxRequests);
  const window = Number(windowMs);

  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("maxRequests must be >= 0 and a safe integer");
  }
  if (!Number.isSafeInteger(window) || window < 1) {
    throw new Error("windowMs must be >= 1 and a safe integer");
  }

  const entries = new Map();

  function purge(now) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  return {
    enabled: limit > 0,

    consume(key, now = Date.now()) {
      if (limit <= 0) {
        return {
          allowed: true,
          limit: 0,
          remaining: Infinity,
          resetAt: null
        };
      }

      if (!Number.isSafeInteger(now) || now < 0 ||
          now > Number.MAX_SAFE_INTEGER - window) {
        throw new Error("now must be a non-negative safe integer and allow a safe window deadline");
      }

      purge(now);
      const normalizedKey = String(key || "unknown");
      let entry = entries.get(normalizedKey);

      if (!entry || entry.resetAt <= now) {
        entry = {
          count: 0,
          resetAt: now + window
        };
        entries.set(normalizedKey, entry);
      }

      entry.count += 1;
      const allowed = entry.count <= limit;

      return {
        allowed,
        limit,
        remaining: Math.max(0, limit - entry.count),
        resetAt: entry.resetAt
      };
    },

    clear() {
      entries.clear();
    },

    size() {
      purge(Date.now());
      return entries.size;
    }
  };
}

import { isIP } from "node:net";

export function getClientKey(req, { trustProxy = false, trustedProxyHops = 1 } = {}) {
  if (trustProxy) {
    if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 1) {
      throw new Error("trustedProxyHops must be a positive safe integer");
    }

    const forwarded = String(req.headers?.["x-forwarded-for"] || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const clientIndex = forwarded.length - trustedProxyHops;
    const candidate = clientIndex >= 0 ? forwarded[clientIndex] : null;

    // Only trust an address supplied through a complete, configured proxy chain.
    // Malformed or shorter-than-configured chains fall back to the socket peer.
    if (candidate && isIP(candidate)) return candidate;
  }

  return req.socket?.remoteAddress || "unknown";
}

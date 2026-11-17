import { isIP } from "node:net";

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

export function getClientKey(req, { trustProxy = false, trustedProxyHops = 1 } = {}) {
  if (trustProxy) {
    if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 1) {
      throw new Error("trustedProxyHops must be a positive safe integer");
    }

    const rawForwarded = String(req.headers?.["x-forwarded-for"] || "");
    const forwarded = rawForwarded.split(",").map(value => value.trim());
    const completeChain = rawForwarded.length > 0 &&
      forwarded.every(value => value.length > 0);
    const clientIndex = forwarded.length - trustedProxyHops;
    const candidate = completeChain && clientIndex >= 0
      ? forwarded[clientIndex]
      : null;
    const trustedSuffix = candidate ? forwarded.slice(clientIndex) : [];

    // Empty/malformed chain segments can shift the hop count and are rejected.
    // Left-side caller-supplied entries do not affect the right-side hop lookup.
    // Every selected/right-side hop must parse as an IP address.
    if (candidate && trustedSuffix.every(value => isIP(value) !== 0)) return candidate;
  }

  return req.socket?.remoteAddress || "unknown";
}

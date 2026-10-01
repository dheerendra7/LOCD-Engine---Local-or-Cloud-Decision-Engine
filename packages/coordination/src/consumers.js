import { fingerprint } from "../../../packages/runtime/src/idempotency.js";
import { assertCoordinationStore } from "./store.js";

function normalizeKey(value) {
  const key = String(value ?? "").trim();
  if (!key || key.length > 512) throw new Error("coordination key is invalid");
  return key;
}

export function createCoordinatedFixedWindowRateLimiter({
  store,
  maxRequests = 0,
  windowMs = 60_000,
  namespace = "locd:rate"
} = {}) {
  assertCoordinationStore(store);

  const limit = Number(maxRequests);
  const window = Number(windowMs);

  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error("maxRequests must be >= 0");
  }
  if (!Number.isFinite(window) || window < 1) {
    throw new Error("windowMs must be >= 1");
  }

  return {
    enabled: limit > 0,

    async consume(key, now = Date.now()) {
      if (limit <= 0) {
        return {
          allowed: true,
          limit: 0,
          remaining: Infinity,
          resetAt: null
        };
      }

      const bucketStart = Math.floor(now / window) * window;
      const resetAt = bucketStart + window;
      const bucketKey = [
        namespace,
        bucketStart,
        fingerprint(normalizeKey(key))
      ].join(":");

      const count = await store.incr(bucketKey, {
        ttlMs: Math.max(1000, window + 1000)
      });

      return {
        allowed: count <= limit,
        limit,
        remaining: Math.max(0, limit - count),
        resetAt
      };
    }
  };
}

export function createCoordinatedIdempotencyStore({
  store,
  ttlMs = 300_000,
  namespace = "locd:idempotency"
} = {}) {
  assertCoordinationStore(store);

  if (!Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new Error("ttlMs must be >= 1");
  }

  function storageKey(scope, key) {
    return namespace + ":" + fingerprint({
      scope: normalizeKey(scope),
      key: normalizeKey(key)
    });
  }

  async function lookup(scope, key, body) {
    if (!key) return null;

    const existing = await store.get(storageKey(scope, key));
    if (!existing) return null;

    const current = fingerprint(body);
    if (existing.fingerprint !== current) {
      throw new Error("idempotency_key_reused");
    }

    return {
      ...existing.response,
      replayed: true
    };
  }

  async function remember(scope, key, body, response) {
    if (!key) return;

    await store.set(storageKey(scope, key), {
      fingerprint: fingerprint(body),
      response: { ...response, replayed: false },
      storedAt: new Date().toISOString()
    }, { ttlMs });
  }

  async function claim(scope, key, body, lockTtlMs = 30_000) {
    if (!key) return { claimed: false, reason: "no_key" };

    const storedKey = storageKey(scope, key);
    const value = {
      fingerprint: fingerprint(body),
      response: null,
      processing: true,
      storedAt: new Date().toISOString()
    };

    const claimed = await store.setIfAbsent(storedKey, value, {
      ttlMs: lockTtlMs
    });

    if (claimed) return { claimed: true };

    const existing = await store.get(storedKey);
    if (existing?.fingerprint !== value.fingerprint) {
      throw new Error("idempotency_key_reused");
    }

    if (existing?.processing) {
      return { claimed: false, reason: "in_progress" };
    }

    return { claimed: false, reason: "completed", response: existing.response };
  }

  return {
    lookup,
    remember,
    claim
  };
}

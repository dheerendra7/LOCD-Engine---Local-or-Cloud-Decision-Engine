import { randomUUID } from "node:crypto";
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
  const missingClaimOperations = ["deleteIfValue", "setIfValue"]
    .filter(method => typeof store[method] !== "function");
  if (missingClaimOperations.length) {
    throw new Error(
      "coordination store must implement " +
      missingClaimOperations.map(method => method + "()").join(" and ") +
      " for safe idempotency claims"
    );
  }

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
    if (existing.processing) return null;

    return structuredClone({
      ...existing.response,
      replayed: true
    });
  }

  async function remember(scope, key, body, response, claimToken = null) {
    if (!key) return false;

    const storedKey = storageKey(scope, key);
    const currentFingerprint = fingerprint(body);
    const completed = {
      fingerprint: currentFingerprint,
      response: structuredClone({ ...response, replayed: false }),
      storedAt: new Date().toISOString()
    };

    if (claimToken) {
      if (typeof store.setIfValue !== "function") return false;
      const existing = await store.get(storedKey);
      if (!existing) {
        // The lease expired without a replacement claim; setIfAbsent fences
        // a new owner racing this late response.
        return store.setIfAbsent(storedKey, completed, { ttlMs });
      }
      if (!existing.processing || existing.claimToken !== claimToken ||
          existing.fingerprint !== currentFingerprint) return false;
      return store.setIfValue(storedKey, existing, completed, { ttlMs });
    }

    await store.set(storedKey, completed, { ttlMs });
    return true;
  }

  async function claim(scope, key, body, lockTtlMs = 30_000) {
    if (!key) return { claimed: false, reason: "no_key" };
    if (!Number.isFinite(lockTtlMs) || lockTtlMs < 1) {
      throw new Error("idempotency_lock_ttl_invalid");
    }

    const storedKey = storageKey(scope, key);
    const value = {
      fingerprint: fingerprint(body),
      claimToken: randomUUID(),
      response: null,
      processing: true,
      storedAt: new Date().toISOString()
    };

    // A competing request may expire/delete the value after setIfAbsent
    // returns false but before get() reads it. Retry atomically rather than
    // misreporting that harmless race as a reused key with a different body.
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = await store.setIfAbsent(storedKey, value, {
        ttlMs: lockTtlMs
      });
      if (claimed) return { claimed: true, claimToken: value.claimToken };

      const existing = await store.get(storedKey);
      if (!existing) continue;

      if (existing.fingerprint !== value.fingerprint) {
        throw new Error("idempotency_key_reused");
      }

      if (existing.processing) {
        return { claimed: false, reason: "in_progress" };
      }

      return {
        claimed: false,
        reason: "completed",
        response: structuredClone(existing.response)
      };
    }

    // Fail closed: a continuously disappearing claim must never be treated
    // as permission to execute the operation without an idempotency claim.
    return { claimed: false, reason: "in_progress" };
  }

  async function release(scope, key, body, claimToken) {
    if (!key || !claimToken || typeof store.deleteIfValue !== "function") return false;
    const storedKey = storageKey(scope, key);
    const existing = await store.get(storedKey);
    if (!existing || !existing.processing || existing.claimToken !== claimToken ||
        existing.fingerprint !== fingerprint(body)) return false;
    return store.deleteIfValue(storedKey, existing);
  }

  return { lookup, remember, claim, release };
}

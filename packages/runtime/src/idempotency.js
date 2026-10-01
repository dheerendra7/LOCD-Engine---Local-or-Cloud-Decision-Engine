import { createHash } from "node:crypto";

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = sortValue(value[key]);
        return out;
      }, {});
  }
  return value;
}

export function fingerprint(value) {
  const normalized = JSON.stringify(sortValue(value));
  return createHash("sha256").update(normalized).digest("hex");
}

export function createIdempotencyStore({ maxEntries = 1000, ttlMs = 300000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer");
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new Error("ttlMs must be a positive number");
  }

  const entries = new Map();

  function purge() {
    const cutoff = Date.now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.createdAt < cutoff) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    lookup(scope, key, body) {
      if (!key) return null;
      purge();

      const normalizedKey = String(key).trim();
      if (!normalizedKey || normalizedKey.length > 256) {
        throw new Error("idempotency_key_invalid");
      }

      const composite = String(scope) + ":" + normalizedKey;
      const existing = entries.get(composite);
      if (!existing) return null;

      const currentFingerprint = fingerprint(body);
      if (existing.fingerprint !== currentFingerprint) {
        throw new Error("idempotency_key_reused");
      }

      return { ...existing.response, replayed: true };
    },

    remember(scope, key, body, response) {
      if (!key) return;
      purge();

      const normalizedKey = String(key).trim();
      if (!normalizedKey || normalizedKey.length > 256) {
        throw new Error("idempotency_key_invalid");
      }

      const composite = String(scope) + ":" + normalizedKey;
      entries.set(composite, {
        fingerprint: fingerprint(body),
        processing: false,
        response: { ...response, replayed: false },
        createdAt: Date.now()
      });
      purge();
    },

    claim(scope, key, body, lockTtlMs = 30000) {
      if (!key) return { claimed: false, reason: "no_key" };
      purge();

      if (!Number.isFinite(lockTtlMs) || lockTtlMs < 1) {
        throw new Error("idempotency_lock_ttl_invalid");
      }

      const normalizedKey = String(key).trim();
      if (!normalizedKey || normalizedKey.length > 256) {
        throw new Error("idempotency_key_invalid");
      }

      const composite = String(scope) + ":" + normalizedKey;
      const bodyFingerprint = fingerprint(body);
      const existing = entries.get(composite);

      if (!existing) {
        entries.set(composite, {
          fingerprint: bodyFingerprint,
          processing: true,
          response: null,
          createdAt: Date.now(),
          lockExpiresAt: Date.now() + lockTtlMs
        });
        return { claimed: true };
      }

      if (existing.fingerprint !== bodyFingerprint) {
        throw new Error("idempotency_key_reused");
      }

      if (existing.processing) {
        if (existing.lockExpiresAt <= Date.now()) {
          entries.set(composite, {
            fingerprint: bodyFingerprint,
            processing: true,
            response: null,
            createdAt: Date.now(),
            lockExpiresAt: Date.now() + lockTtlMs
          });
          return { claimed: true, reclaimed: true };
        }
        return { claimed: false, reason: "in_progress" };
      }

      return {
        claimed: false,
        reason: "completed",
        response: { ...existing.response, replayed: true }
      };
    },

    release(scope, key, body) {
      if (!key) return false;
      purge();

      const normalizedKey = String(key).trim();
      if (!normalizedKey || normalizedKey.length > 256) {
        throw new Error("idempotency_key_invalid");
      }

      const composite = String(scope) + ":" + normalizedKey;
      const existing = entries.get(composite);
      if (!existing) return false;

      if (existing.fingerprint !== fingerprint(body)) {
        throw new Error("idempotency_key_reused");
      }

      if (!existing.processing) return false;
      entries.delete(composite);
      return true;
    },

    size() {
      purge();
      return entries.size;
    },

    clear() {
      entries.clear();
    }
  };
}

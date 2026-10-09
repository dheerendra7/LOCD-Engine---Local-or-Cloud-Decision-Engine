import { createHash } from "node:crypto";

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = sortValue(value[key]);
        return out;
      }, Object.create(null));
  }
  return value;
}

export function fingerprint(value) {
  const normalized = JSON.stringify(sortValue(value));
  return createHash("sha256").update(normalized).digest("hex");
}

export function createIdempotencyStore({
  maxEntries = 1000,
  ttlMs = 300000,
  clock = () => Date.now()
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer");
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new Error("ttlMs must be a positive number");
  }

  const entries = new Map();

  function purge(now = clock()) {
    for (const [key, entry] of entries) {
      const expiresAt = entry.expiresAt ?? (entry.createdAt + ttlMs);
      if (expiresAt <= now) entries.delete(key);
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

      return structuredClone({ ...existing.response, replayed: true });
    },

    remember(scope, key, body, response) {
      if (!key) return;
      purge();

      const normalizedKey = String(key).trim();
      if (!normalizedKey || normalizedKey.length > 256) {
        throw new Error("idempotency_key_invalid");
      }

      const now = clock();
      const composite = String(scope) + ":" + normalizedKey;
      entries.set(composite, {
        fingerprint: fingerprint(body),
        response: structuredClone({ ...response, replayed: false }),
        createdAt: now,
        expiresAt: now + ttlMs
      });
      purge();
    },

    claim(scope, key, body, lockTtlMs = 30_000) {
      if (!key) return { claimed: false, reason: "no_key" };
      if (!Number.isFinite(lockTtlMs) || lockTtlMs < 1) {
        throw new Error("idempotency_lock_ttl_invalid");
      }

      purge();
      const normalizedKey = String(key).trim();
      if (!normalizedKey || normalizedKey.length > 256) {
        throw new Error("idempotency_key_invalid");
      }

      const composite = String(scope) + ":" + normalizedKey;
      const currentFingerprint = fingerprint(body);
      const existing = entries.get(composite);

      if (existing) {
        if (existing.fingerprint !== currentFingerprint) {
          throw new Error("idempotency_key_reused");
        }

        if (existing.processing) {
          return { claimed: false, reason: "in_progress" };
        }

        return {
          claimed: false,
          reason: "completed",
          response: structuredClone({ ...existing.response, replayed: true })
        };
      }

      const now = clock();
      entries.set(composite, {
        fingerprint: currentFingerprint,
        processing: true,
        response: null,
        createdAt: now,
        expiresAt: now + lockTtlMs
      });

      return { claimed: true };
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

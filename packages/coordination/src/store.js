import { isDeepStrictEqual } from "node:util";

export function createInMemoryCoordinationStore() {
  const values = new Map();
  const expiries = new Map();

  function resolveExpiry(ttlMs) {
    if (ttlMs == null) return null;
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be >= 1");
    const expiresAt = Math.ceil(Date.now() + ttlMs);
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error("ttlMs exceeds supported expiry range");
    }
    return expiresAt;
  }

  function purge(now = Date.now()) {
    for (const [key, expiresAt] of expiries) {
      if (expiresAt <= now) {
        expiries.delete(key);
        values.delete(key);
      }
    }
  }

  return {
    capabilities: Object.freeze({
      durable: false,
      shared: false,
      tenantScoped: true,
      transactional: false
    }),

    async get(key) {
      purge();
      const value = values.get(String(key));
      return value === undefined ? null : structuredClone(value);
    },

    async set(key, value, { ttlMs = null } = {}) {
      const expiresAt = resolveExpiry(ttlMs);
      purge();
      const normalized = String(key);
      values.set(normalized, structuredClone(value));
      if (expiresAt === null) expiries.delete(normalized);
      else expiries.set(normalized, expiresAt);
      return true;
    },

    async setIfAbsent(key, value, { ttlMs = null } = {}) {
      const expiresAt = resolveExpiry(ttlMs);
      purge();
      const normalized = String(key);
      if (values.has(normalized)) return false;

      values.set(normalized, structuredClone(value));
      if (expiresAt === null) expiries.delete(normalized);
      else expiries.set(normalized, expiresAt);
      return true;
    },

    async setIfValue(key, expectedValue, value, { ttlMs = null } = {}) {
      const expiresAt = resolveExpiry(ttlMs);
      purge();
      const normalized = String(key);
      if (!values.has(normalized) || !isDeepStrictEqual(values.get(normalized), expectedValue)) return false;

      values.set(normalized, structuredClone(value));
      if (expiresAt === null) expiries.delete(normalized);
      else expiries.set(normalized, expiresAt);
      return true;
    },

    async delete(key) {
      purge();
      const normalized = String(key);
      expiries.delete(normalized);
      return values.delete(normalized);
    },

    async deleteIfValue(key, expectedValue) {
      purge();
      const normalized = String(key);
      if (!values.has(normalized) || !isDeepStrictEqual(values.get(normalized), expectedValue)) return false;
      expiries.delete(normalized);
      return values.delete(normalized);
    },

    async incr(key, { ttlMs = null } = {}) {
      const expiresAt = resolveExpiry(ttlMs);
      purge();
      const normalized = String(key);
      const currentValue = values.has(normalized) ? values.get(normalized) : 0;
      if (!Number.isSafeInteger(currentValue) || currentValue < 0) {
        throw new Error("coordination counter must be a non-negative safe integer");
      }
      const next = currentValue + 1;
      if (!Number.isSafeInteger(next)) throw new Error("coordination counter overflow");
      values.set(normalized, next);
      if (expiresAt !== null && !expiries.has(normalized)) {
        expiries.set(normalized, expiresAt);
      }
      return next;
    },

    async clear() {
      values.clear();
      expiries.clear();
    }
  };
}

export function assertCoordinationStore(store) {
  if (!store || typeof store !== "object") {
    throw new Error("coordination store must be an object");
  }
  for (const method of ["get", "set", "setIfAbsent", "delete", "incr"]) {
    if (typeof store[method] !== "function") {
      throw new Error("coordination store must implement " + method + "()");
    }
  }
  return store;
}

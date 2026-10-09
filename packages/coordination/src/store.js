import { isDeepStrictEqual } from "node:util";

export function createInMemoryCoordinationStore() {
  const values = new Map();
  const expiries = new Map();

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
      purge();
      const normalized = String(key);
      values.set(normalized, structuredClone(value));
      if (ttlMs == null) {
        expiries.delete(normalized);
      } else {
        if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be >= 1");
        expiries.set(normalized, Date.now() + ttlMs);
      }
      return true;
    },

    async setIfAbsent(key, value, { ttlMs = null } = {}) {
      purge();
      const normalized = String(key);
      if (values.has(normalized)) return false;

      values.set(normalized, structuredClone(value));
      if (ttlMs == null) {
        expiries.delete(normalized);
      } else {
        if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be >= 1");
        expiries.set(normalized, Date.now() + ttlMs);
      }
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
      purge();
      const normalized = String(key);
      const current = Number(values.get(normalized) || 0);
      const next = current + 1;
      values.set(normalized, next);
      if (ttlMs != null && !expiries.has(normalized)) {
        if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be >= 1");
        expiries.set(normalized, Date.now() + ttlMs);
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

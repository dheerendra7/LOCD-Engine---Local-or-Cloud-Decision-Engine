function joinUrl(baseUrl, pathname) {
  return String(baseUrl).replace(/\/$/, "") + pathname;
}

function headers(apiKey, tenantId, extra = {}) {
  return {
    accept: "application/json",
    ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
    ...(tenantId ? { "x-locd-tenant-id": String(tenantId) } : {}),
    ...extra
  };
}

async function request(fetchImpl, baseUrl, apiKey, pathname, options = {}, tenantId = null) {
  const response = await fetchImpl(joinUrl(baseUrl, pathname), {
    ...options,
    headers: headers(apiKey, tenantId, options.headers)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "state service request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function encodeKey(key) {
  return encodeURIComponent(String(key));
}

export function createHTTPDecisionStore({
  baseUrl,
  apiKey = null,
  fetchImpl = globalThis.fetch,
  maxEntries = 5000
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const store = {
    capabilities: Object.freeze({
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: false
    }),

    async record(event) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      }, event?.tenantId ?? null);
    },

    async recordOutcome(id, patch, { tenantId = null } = {}) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/outcomes/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      }, tenantId);
    },

    async list({ limit = 50, tenantId = null } = {}) {
      const safeLimit = Math.min(maxEntries, Math.max(1, Number(limit) || 50));
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/decisions?limit=" + safeLimit,
        {},
        tenantId
      );
      return response.decisions || [];
    },

    async summary({ tenantId = null } = {}) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/metrics", {}, tenantId);
    },

    clear({ tenantId = null } = {}) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/telemetry/clear", {
        method: "POST"
      }, tenantId);
    }
  };

  return store;
}

export function createHTTPPolicyStore({
  baseUrl,
  apiKey = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const policyPath = id => "/v1/state/policies/" + encodeKey(id);

  return {
    capabilities: Object.freeze({
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: false
    }),

    async list(tenantId) {
      const response = await request(
        fetchImpl, baseUrl, apiKey, "/v1/state/policies", {}, tenantId
      );
      return response.policies || [];
    },

    async get(tenantId, id) {
      try {
        return await request(
          fetchImpl, baseUrl, apiKey, policyPath(id), {}, tenantId
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async history(tenantId, id) {
      try {
        return await request(
          fetchImpl, baseUrl, apiKey, policyPath(id) + "/history", {}, tenantId
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async upsert(tenantId, input, metadata = {}) {
      const body = {
        policy: input,
        updatedBy: metadata.updatedBy ?? null
      };
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/policies",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        },
        tenantId
      );
      return response;
    },

    async rollback(tenantId, id, version, metadata = {}) {
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        policyPath(id) + "/rollback",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version,
            updatedBy: metadata.updatedBy ?? null
          })
        },
        tenantId
      );
      return response;
    },

    async remove(tenantId, id) {
      try {
        await request(
          fetchImpl,
          baseUrl,
          apiKey,
          policyPath(id),
          { method: "DELETE" },
          tenantId
        );
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    }
  };
}

export function createHTTPCoordinationStore({
  baseUrl,
  apiKey = null,
  fetchImpl = globalThis.fetch
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  return {
    capabilities: Object.freeze({
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: false
    }),

    async get(key) {
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/kv/" + encodeKey(key)
      );
      return response.value ?? null;
    },

    async set(key, value, { ttlMs = null } = {}) {
      return request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/kv/" + encodeKey(key),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value, ttlMs })
        }
      ).then(() => true);
    },

    async setIfAbsent(key, value, { ttlMs = null } = {}) {
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/kv/" + encodeKey(key) + "/set-if-absent",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value, ttlMs })
        }
      );
      return response.claimed === true;
    },

    async delete(key) {
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/kv/" + encodeKey(key),
        { method: "DELETE" }
      );
      return response.deleted === true;
    },

    async incr(key, { ttlMs = null } = {}) {
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/kv/" + encodeKey(key) + "/incr",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ttlMs })
        }
      );
      return Number(response.value);
    },

    async clear() {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/coordination/clear", {
        method: "POST"
      });
    }
  };
}

export function createHTTPStateStores({
  baseUrl,
  apiKey = null,
  fetchImpl = globalThis.fetch,
  maxEntries = 5000
} = {}) {
  return {
    telemetry: createHTTPDecisionStore({ baseUrl, apiKey, fetchImpl, maxEntries }),
    coordination: createHTTPCoordinationStore({ baseUrl, apiKey, fetchImpl }),
    policies: createHTTPPolicyStore({ baseUrl, apiKey, fetchImpl })
  };
}

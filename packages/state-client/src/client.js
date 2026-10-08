function joinUrl(baseUrl, pathname) {
  return String(baseUrl).replace(/\/$/, "") + pathname;
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be >= 1");
  }
  return timeoutMs;
}

function timeoutError() {
  const error = new Error("state_service_timeout");
  error.code = "STATE_SERVICE_TIMEOUT";
  error.status = 504;
  return error;
}

function headers(apiKey, tenantId, extra = {}) {
  return {
    accept: "application/json",
    ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
    ...(tenantId ? { "x-locd-tenant-id": String(tenantId) } : {}),
    ...extra
  };
}

async function request(
  fetchImpl,
  baseUrl,
  apiKey,
  pathname,
  options = {},
  tenantId = null,
  timeoutMs = 5_000
) {
  const signal = AbortSignal.timeout(validateTimeout(timeoutMs));
  let response;

  try {
    response = await fetchImpl(joinUrl(baseUrl, pathname), {
      ...options,
      signal,
      headers: headers(apiKey, tenantId, options.headers)
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw timeoutError();
    }
    throw error;
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestError = new Error(body.error || "state service request failed");
    requestError.status = response.status;
    requestError.body = body;
    throw requestError;
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
  maxEntries = 5000,
  timeoutMs = Number(process.env.LOCD_STATE_CLIENT_TIMEOUT_MS || 5_000)
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  validateTimeout(timeoutMs);

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
      }, event?.tenantId ?? null, timeoutMs);
    },

    async recordOutcome(id, patch, { tenantId = null } = {}) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/outcomes/" + encodeURIComponent(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      }, tenantId, timeoutMs);
    },

    async list({ limit = 50, tenantId = null } = {}) {
      const safeLimit = Math.min(maxEntries, Math.max(1, Number(limit) || 50));
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/decisions?limit=" + safeLimit,
        {},
        tenantId,
        timeoutMs
      );
      return response.decisions || [];
    },

    async summary({ tenantId = null } = {}) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/metrics", {}, tenantId, timeoutMs);
    },

    clear({ tenantId = null } = {}) {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/telemetry/clear", {
        method: "POST"
      }, tenantId, timeoutMs);
    }
  };

  return store;
}

export function createHTTPPolicyStore({
  baseUrl,
  apiKey = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.LOCD_STATE_CLIENT_TIMEOUT_MS || 5_000)
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  validateTimeout(timeoutMs);

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
        fetchImpl, baseUrl, apiKey, "/v1/state/policies", {}, tenantId, timeoutMs
      );
      return response.policies || [];
    },

    async get(tenantId, id) {
      try {
        return await request(
          fetchImpl, baseUrl, apiKey, policyPath(id), {}, tenantId, timeoutMs
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async history(tenantId, id) {
      try {
        return await request(
          fetchImpl, baseUrl, apiKey, policyPath(id) + "/history", {}, tenantId, timeoutMs
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
        tenantId,
        timeoutMs
      );
      return response;
    },

    async rollback(tenantId, id, version, metadata = {}) {
      try {
        return await request(
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
          tenantId,
          timeoutMs
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async remove(tenantId, id) {
      try {
        await request(
          fetchImpl,
          baseUrl,
          apiKey,
          policyPath(id),
          { method: "DELETE" },
          tenantId,
          timeoutMs
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
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.LOCD_STATE_CLIENT_TIMEOUT_MS || 5_000)
} = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  validateTimeout(timeoutMs);

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
        "/v1/state/kv/" + encodeKey(key),
        null,
        timeoutMs
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
        },
        null,
        timeoutMs
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
        },
        null,
        timeoutMs
      );
      return response.claimed === true;
    },

    async delete(key) {
      const response = await request(
        fetchImpl,
        baseUrl,
        apiKey,
        "/v1/state/kv/" + encodeKey(key),
        { method: "DELETE" },
        null,
        timeoutMs
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
        },
        null,
        timeoutMs
      );
      return Number(response.value);
    },

    async clear() {
      return request(fetchImpl, baseUrl, apiKey, "/v1/state/coordination/clear", {
        method: "POST"
      }, null, timeoutMs);
    }
  };
}

export function createHTTPStateStores({
  baseUrl,
  apiKey = null,
  fetchImpl = globalThis.fetch,
  maxEntries = 5000,
  timeoutMs = Number(process.env.LOCD_STATE_CLIENT_TIMEOUT_MS || 5_000)
} = {}) {
  validateTimeout(timeoutMs);
  return {
    telemetry: createHTTPDecisionStore({ baseUrl, apiKey, fetchImpl, maxEntries, timeoutMs }),
    coordination: createHTTPCoordinationStore({ baseUrl, apiKey, fetchImpl, timeoutMs }),
    policies: createHTTPPolicyStore({ baseUrl, apiKey, fetchImpl, timeoutMs })
  };
}

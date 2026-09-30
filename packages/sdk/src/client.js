function joinUrl(baseUrl, pathname) {
  return String(baseUrl).replace(/\/$/, "") + pathname;
}

function operationHeaders(options = {}) {
  const result = {};
  if (options.idempotencyKey) result["idempotency-key"] = String(options.idempotencyKey);
  if (options.requestId) result["x-request-id"] = String(options.requestId);
  return result;
}

export function createLocdClient({ baseUrl, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  async function request(pathname, options = {}) {
    const response = await fetchImpl(joinUrl(baseUrl, pathname), {
      ...options,
      headers: {
        accept: "application/json",
        ...headers,
        ...(options.headers || {})
      }
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "LOCD request failed");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  return {
    async health() {
      return request("/health");
    },

    async decide(decisionRequest, options = {}) {
      return request("/v1/decide", {
        method: "POST",
        headers: { "content-type": "application/json", ...operationHeaders(options) },
        body: JSON.stringify(decisionRequest)
      });
    },

    async recordOutcome(outcome, options = {}) {
      if (!outcome?.decisionId) throw new Error("decisionId is required");
      return request("/v1/outcomes", {
        method: "POST",
        headers: { "content-type": "application/json", ...operationHeaders(options) },
        body: JSON.stringify(outcome)
      });
    },

    async hybridPlan(plan, options = {}) {
      return request("/v1/hybrid-plan", {
        method: "POST",
        headers: { "content-type": "application/json", ...operationHeaders(options) },
        body: JSON.stringify(plan)
      });
    },

    async registerTarget(target, options = {}) {
      return request("/v1/targets", {
        method: "POST",
        headers: { "content-type": "application/json", ...operationHeaders(options) },
        body: JSON.stringify(target)
      });
    },

    async heartbeat(targetId, telemetry, options = {}) {
      return request("/v1/targets/" + encodeURIComponent(targetId) + "/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", ...operationHeaders(options) },
        body: JSON.stringify(telemetry)
      });
    },

    async policies() {
      return request("/v1/policies");
    },

    async decisions(limit = 50) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 50));
      return request("/v1/decisions?limit=" + safeLimit);
    },

    async metrics() {
      return request("/v1/metrics");
    }
  };
}

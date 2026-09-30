function assertSafeBaseUrl(value, { allowInsecureHttp = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("baseUrl must use http or https");
  }

  const hostname = url.hostname.toLowerCase();
  const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol === "http:" && !local && !allowInsecureHttp) {
    throw new Error("insecure remote HTTP requires allowInsecureHttp=true");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

const MODES = new Set(["local", "private", "cloud", "hybrid"]);

function authHeaders(apiKey) {
  return apiKey ? { authorization: "Bearer " + apiKey } : {};
}

function timeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal: undefined, cancel: () => {} };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

function normalizeSnapshot(snapshot) {
  return {
    id: snapshot.id,
    mode: snapshot.mode,
    available: snapshot.available !== false,
    health: Number.isFinite(Number(snapshot.health)) ? Math.min(1, Math.max(0, Number(snapshot.health))) : 0,
    capacity: Number.isFinite(Number(snapshot.capacity)) ? Math.min(1, Math.max(0, Number(snapshot.capacity))) : 1,
    privacy: Number.isFinite(Number(snapshot.privacy)) ? Math.min(1, Math.max(0, Number(snapshot.privacy))) : 0,
    estimatedLatencyMs: Number.isFinite(Number(snapshot.estimatedLatencyMs)) ? Math.max(0, Number(snapshot.estimatedLatencyMs)) : null,
    estimatedCostUsd: Number.isFinite(Number(snapshot.estimatedCostUsd)) ? Math.max(0, Number(snapshot.estimatedCostUsd)) : null,
    availableMemoryGb: Number.isFinite(Number(snapshot.availableMemoryGb)) ? Math.max(0, Number(snapshot.availableMemoryGb)) : null,
    maxContextTokens: Number.isFinite(Number(snapshot.maxContextTokens)) ? Math.max(0, Number(snapshot.maxContextTokens)) : null,
    lastHeartbeatAt: snapshot.lastHeartbeatAt ? new Date(snapshot.lastHeartbeatAt).toISOString() : null,
    regions: Array.isArray(snapshot.regions) ? [...new Set(snapshot.regions.map(String))] : [],
    capabilities: Array.isArray(snapshot.capabilities) ? [...new Set(snapshot.capabilities.map(String))] : []
  };
}

export function createOpenAICompatibleAdapter({
  id,
  targetId,
  baseUrl,
  mode = "cloud",
  apiKey = null,
  model = null,
  privacy = 0.2,
  estimatedCostUsd = null,
  regions = [],
  capabilities = ["text-generation"],
  allowInsecureHttp = false,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  initial = {}
} = {}) {
  if (!id) throw new Error("id is required");
  if (!targetId) throw new Error("targetId is required");
  if (!MODES.has(mode)) throw new Error("mode must be local, private, cloud or hybrid");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const url = assertSafeBaseUrl(baseUrl, { allowInsecureHttp });
  if (mode === "local" && url.hostname === "localhost") {
    // valid local combination
  }

  let snapshot = normalizeSnapshot({
    id: targetId,
    mode,
    available: initial.available !== false,
    health: initial.health ?? 0,
    capacity: initial.capacity ?? 1,
    privacy: initial.privacy ?? privacy,
    estimatedLatencyMs: initial.estimatedLatencyMs ?? null,
    estimatedCostUsd: initial.estimatedCostUsd ?? estimatedCostUsd,
    availableMemoryGb: initial.availableMemoryGb ?? null,
    maxContextTokens: initial.maxContextTokens ?? null,
    lastHeartbeatAt: initial.lastHeartbeatAt ?? null,
    regions,
    capabilities
  });

  async function probe() {
    const started = performance.now();
    const timeout = timeoutSignal(timeoutMs);

    try {
      const response = await fetchImpl(new URL("/v1/models", url), {
        method: "GET",
        headers: {
          accept: "application/json",
          ...authHeaders(apiKey)
        },
        signal: timeout.signal
      });

      const latency = Math.max(0, performance.now() - started);
      snapshot = {
        ...snapshot,
        available: response.ok,
        health: response.ok ? 1 : 0,
        estimatedLatencyMs: Number(latency.toFixed(2)),
        lastHeartbeatAt: new Date().toISOString()
      };

      if (!response.ok) {
        snapshot.errorClass = "probe_http_" + response.status;
      } else {
        delete snapshot.errorClass;
      }

      return structuredClone(snapshot);
    } catch (error) {
      const errorClass = error?.name === "AbortError"
        ? "probe_timeout"
        : "probe_network_error";

      snapshot = {
        ...snapshot,
        available: false,
        health: 0,
        estimatedLatencyMs: Number(Math.max(0, performance.now() - started).toFixed(2)),
        lastHeartbeatAt: new Date().toISOString(),
        errorClass
      };

      return structuredClone(snapshot);
    } finally {
      timeout.cancel();
    }
  }

  async function execute({ payload, mode: executionMode = "live" } = {}) {
    if (executionMode !== "live") {
      throw new Error("provider execution requires live mode");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("execution payload must be an object");
    }

    const timeout = timeoutSignal(timeoutMs);
    try {
      const body = {
        ...payload,
        ...(model && !payload.model ? { model } : {})
      };

      const response = await fetchImpl(new URL("/v1/chat/completions", url), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...authHeaders(apiKey)
        },
        body: JSON.stringify(body),
        signal: timeout.signal
      });

      if (!response.ok) {
        throw new Error("provider_http_" + response.status);
      }

      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("provider_timeout");
      throw error;
    } finally {
      timeout.cancel();
    }
  }

  return {
    id: String(id),
    targetId: String(targetId),
    capabilities: [...capabilities],
    getSnapshot: async () => structuredClone(snapshot),
    setSnapshot: async patch => {
      if (patch?.id && String(patch.id) !== String(targetId)) {
        throw new Error("adapter id cannot change");
      }
      snapshot = normalizeSnapshot({ ...snapshot, ...patch, id: targetId });
      return structuredClone(snapshot);
    },
    probe,
    execute
  };
}

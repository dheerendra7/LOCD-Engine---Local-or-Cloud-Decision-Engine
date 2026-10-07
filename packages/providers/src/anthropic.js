const MODES = new Set(["local", "private", "cloud", "hybrid"]);

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

  if (url.username || url.password) {
    throw new Error("baseUrl must not contain embedded credentials");
  }

  const hostname = url.hostname.toLowerCase();
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  if (url.protocol === "http:" && !local && !allowInsecureHttp) {
    throw new Error("insecure remote HTTP requires allowInsecureHttp=true");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function authHeaders(apiKey, anthropicVersion) {
  return {
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    "anthropic-version": anthropicVersion
  };
}

function timeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { signal: undefined, cancel: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

function number(value, fallback = null, min = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, parsed) : fallback;
}

function normalizeSnapshot(snapshot) {
  return {
    id: String(snapshot.id),
    mode: snapshot.mode,
    available: snapshot.available !== false,
    health: Math.min(1, Math.max(0, number(snapshot.health, 0))),
    capacity: Math.min(1, Math.max(0, number(snapshot.capacity, 1))),
    privacy: Math.min(1, Math.max(0, number(snapshot.privacy, 0))),
    estimatedLatencyMs: number(snapshot.estimatedLatencyMs),
    estimatedCostUsd: number(snapshot.estimatedCostUsd),
    pricing: snapshot.pricing && typeof snapshot.pricing === "object"
      ? structuredClone(snapshot.pricing)
      : null,
    availableMemoryGb: number(snapshot.availableMemoryGb),
    maxContextTokens: number(snapshot.maxContextTokens),
    lastHeartbeatAt: snapshot.lastHeartbeatAt
      ? new Date(snapshot.lastHeartbeatAt).toISOString()
      : null,
    errorClass: snapshot.errorClass ? String(snapshot.errorClass) : null,
    regions: Array.isArray(snapshot.regions)
      ? [...new Set(snapshot.regions.map(String))]
      : [],
    capabilities: Array.isArray(snapshot.capabilities)
      ? [...new Set(snapshot.capabilities.map(String))]
      : []
  };
}

export function createAnthropicAdapter({
  id,
  targetId,
  baseUrl = "https://api.anthropic.com",
  mode = "cloud",
  apiKey = null,
  model = null,
  maxTokens = 1024,
  anthropicVersion = "2023-06-01",
  privacy = 0.2,
  estimatedCostUsd = null,
  regions = [],
  capabilities = ["text-generation"],
  allowInsecureHttp = false,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  initial = {},
  pricing = null
} = {}) {
  if (!id) throw new Error("id is required");
  if (!targetId) throw new Error("targetId is required");
  if (!MODES.has(mode)) throw new Error("mode must be local, private, cloud or hybrid");
  if (!anthropicVersion || typeof anthropicVersion !== "string") {
    throw new Error("anthropicVersion must be a string");
  }
  if (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 1) {
    throw new Error("maxTokens must be a positive integer");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const url = assertSafeBaseUrl(baseUrl, { allowInsecureHttp });

  let snapshot = normalizeSnapshot({
    id: targetId,
    mode,
    available: initial.available === true,
    health: initial.health ?? 0,
    capacity: initial.capacity ?? 1,
    privacy: initial.privacy ?? privacy,
    estimatedLatencyMs: initial.estimatedLatencyMs ?? null,
    estimatedCostUsd: initial.estimatedCostUsd ?? estimatedCostUsd,
    pricing: initial.pricing ?? pricing,
    availableMemoryGb: initial.availableMemoryGb ?? null,
    maxContextTokens: initial.maxContextTokens ?? null,
    lastHeartbeatAt: initial.lastHeartbeatAt ?? null,
    regions,
    capabilities,
    errorClass: initial.errorClass ?? null
  });

  async function probe() {
    const started = performance.now();
    const timeout = timeoutSignal(timeoutMs);

    try {
      const response = await fetchImpl(new URL("/v1/models", url), {
        method: "GET",
        headers: {
          accept: "application/json",
          ...authHeaders(apiKey, anthropicVersion)
        },
        signal: timeout.signal
      });

      const latency = Math.max(0, performance.now() - started);
      snapshot = {
        ...snapshot,
        available: response.ok,
        health: response.ok ? 1 : 0,
        estimatedLatencyMs: Number(latency.toFixed(2)),
        lastHeartbeatAt: new Date().toISOString(),
        errorClass: response.ok ? null : "probe_http_" + response.status
      };

      return structuredClone(snapshot);
    } catch (error) {
      snapshot = {
        ...snapshot,
        available: false,
        health: 0,
        estimatedLatencyMs: Number(Math.max(0, performance.now() - started).toFixed(2)),
        lastHeartbeatAt: new Date().toISOString(),
        errorClass: error?.name === "AbortError"
          ? "probe_timeout"
          : "probe_network_error"
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

    const request = {
      ...payload,
      ...(model && !payload.model ? { model } : {}),
      ...(payload.max_tokens == null ? { max_tokens: Number(maxTokens) } : {}),
      ...(payload.stream == null ? { stream: false } : {})
    };

    if (!request.model) {
      throw new Error("Anthropic execution requires a model");
    }

    const timeout = timeoutSignal(timeoutMs);
    try {
      const response = await fetchImpl(new URL("/v1/messages", url), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...authHeaders(apiKey, anthropicVersion)
        },
        body: JSON.stringify(request),
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
      snapshot = normalizeSnapshot({
        ...snapshot,
        ...patch,
        id: targetId
      });
      return structuredClone(snapshot);
    },
    probe,
    execute
  };
}

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

  const hostname = url.hostname.toLowerCase();
  const local =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1";

  if (url.protocol === "http:" && !local && !allowInsecureHttp) {
    throw new Error("insecure remote HTTP requires allowInsecureHttp=true");
  }

  url.search = "";
  url.hash = "";
  return url;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: "Bearer " + apiKey } : {};
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

function snapshotValue(value, fallback, { min = 0, max = 1 } = {}) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) return fallback;
  return Math.min(max, number);
}

function optionalNonNegative(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function createOllamaAdapter({
  id,
  targetId,
  baseUrl = "http://localhost:11434/api",
  mode = "local",
  apiKey = null,
  model = null,
  privacy = 1,
  estimatedCostUsd,
  regions = ["local"],
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive finite number");
  }

  const url = assertSafeBaseUrl(baseUrl, { allowInsecureHttp });
  const fallbackEstimatedCostUsd = estimatedCostUsd === undefined
    ? 0
    : optionalNonNegative(estimatedCostUsd);

  let snapshot = {
    id: String(targetId),
    mode,
    available: initial.available !== false,
    health: snapshotValue(initial.health, 0),
    capacity: snapshotValue(initial.capacity, 1),
    privacy: snapshotValue(initial.privacy, privacy),
    estimatedLatencyMs: optionalNonNegative(initial.estimatedLatencyMs),
    estimatedCostUsd: Object.hasOwn(initial, "estimatedCostUsd")
      ? optionalNonNegative(initial.estimatedCostUsd)
      : fallbackEstimatedCostUsd,
    availableMemoryGb: optionalNonNegative(initial.availableMemoryGb),
    maxContextTokens: optionalNonNegative(initial.maxContextTokens),
    lastHeartbeatAt: initial.lastHeartbeatAt
      ? new Date(initial.lastHeartbeatAt).toISOString()
      : null,
    errorClass: initial.errorClass ? String(initial.errorClass) : null,
    regions: Array.isArray(initial.regions) ? [...new Set(initial.regions.map(String))] : [...regions],
    capabilities: Array.isArray(initial.capabilities)
      ? [...new Set(initial.capabilities.map(String))]
      : [...capabilities]
  };

  async function probe() {
    const started = performance.now();
    const timeout = timeoutSignal(timeoutMs);

    try {
      const response = await fetchImpl(new URL("/api/tags", url), {
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
      stream: false
    };

    if (!request.model) {
      throw new Error("Ollama execution requires a model");
    }

    const timeout = timeoutSignal(timeoutMs);
    try {
      const response = await fetchImpl(new URL("/api/chat", url), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...authHeaders(apiKey)
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
      snapshot = {
        ...snapshot,
        ...patch,
        id: String(targetId),
        health: snapshotValue(patch?.health ?? snapshot.health, snapshot.health),
        capacity: snapshotValue(patch?.capacity ?? snapshot.capacity, snapshot.capacity),
        privacy: snapshotValue(patch?.privacy ?? snapshot.privacy, snapshot.privacy),
        estimatedLatencyMs: patch?.estimatedLatencyMs == null
          ? snapshot.estimatedLatencyMs
          : Math.max(0, Number(patch.estimatedLatencyMs)),
        estimatedCostUsd: patch?.estimatedCostUsd == null
          ? snapshot.estimatedCostUsd
          : Math.max(0, Number(patch.estimatedCostUsd)),
        lastHeartbeatAt: patch?.lastHeartbeatAt
          ? new Date(patch.lastHeartbeatAt).toISOString()
          : snapshot.lastHeartbeatAt,
        regions: Array.isArray(patch?.regions) ? [...new Set(patch.regions.map(String))] : snapshot.regions,
        capabilities: Array.isArray(patch?.capabilities)
          ? [...new Set(patch.capabilities.map(String))]
          : snapshot.capabilities,
        errorClass: patch?.errorClass === undefined
          ? snapshot.errorClass
          : patch.errorClass
      };
      return structuredClone(snapshot);
    },
    probe,
    execute
  };
}

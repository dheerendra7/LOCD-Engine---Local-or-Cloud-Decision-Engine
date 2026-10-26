const DEFAULT_ALPHA = 0.25;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_MIN_FACTOR = 0.25;
const DEFAULT_MAX_FACTOR = 4;
const DEFAULT_TENANT_ID = "default";
const DEFAULT_UTILIZATION_BANDS = Object.freeze({
  low: 0.25,
  moderate: 0.60,
  high: 0.85
});

function finite(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTenantId(value) {
  const tenantId = String(value ?? DEFAULT_TENANT_ID).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(tenantId)) {
    throw new Error("tenantId must match /^[a-z0-9][a-z0-9._-]{0,62}$/");
  }
  return tenantId;
}

function keyFor(tenantId, targetId, workloadType, utilizationBand = "unknown") {
  return normalizeTenantId(tenantId) + "::" + String(targetId) + "::" +
    String(workloadType || "unknown") + "::" + utilizationBand;
}

function utilizationBandFor(value, bands = DEFAULT_UTILIZATION_BANDS) {
  const utilization = finite(value);
  if (utilization == null) return "unknown";
  const normalized = Math.min(1, Math.max(0, utilization));

  if (normalized <= bands.low) return "low";
  if (normalized <= bands.moderate) return "moderate";
  if (normalized <= bands.high) return "high";
  return "saturated";
}

function clampFactor(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validateOptions({
  alpha = DEFAULT_ALPHA,
  minSamples = DEFAULT_MIN_SAMPLES,
  minFactor = DEFAULT_MIN_FACTOR,
  maxFactor = DEFAULT_MAX_FACTOR,
  utilizationBands = DEFAULT_UTILIZATION_BANDS
} = {}) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error("alpha must be > 0 and <= 1");
  }
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    throw new Error("minSamples must be a positive integer");
  }
  if (!Number.isFinite(minFactor) || minFactor <= 0) {
    throw new Error("minFactor must be > 0");
  }
  if (!Number.isFinite(maxFactor) || maxFactor < minFactor) {
    throw new Error("maxFactor must be >= minFactor");
  }

  if (!utilizationBands || typeof utilizationBands !== "object") {
    throw new Error("utilizationBands must be an object");
  }
  const bandValues = [utilizationBands.low, utilizationBands.moderate, utilizationBands.high]
    .map(Number);
  if (
    bandValues.some(value => !Number.isFinite(value) || value < 0 || value > 1) ||
    !(bandValues[0] < bandValues[1] && bandValues[1] < bandValues[2])
  ) {
    throw new Error("utilizationBands must be increasing values between 0 and 1");
  }

  return {
    alpha,
    minSamples,
    minFactor,
    maxFactor,
    utilizationBands: {
      low: bandValues[0],
      moderate: bandValues[1],
      high: bandValues[2]
    }
  };
}

function updateFactor(previous, ratio, alpha, minFactor, maxFactor) {
  const safeRatio = clampFactor(ratio, minFactor, maxFactor);
  return previous == null
    ? safeRatio
    : clampFactor(previous * (1 - alpha) + safeRatio * alpha, minFactor, maxFactor);
}

export function createCalibrator(options = {}) {
  const config = validateOptions(options);
  const observations = new Map();

  function observe({
    tenantId = DEFAULT_TENANT_ID,
    targetId,
    workloadType = "unknown",
    estimatedLatencyMs,
    actualLatencyMs,
    estimatedCostUsd,
    actualCostUsd,
    outcome,
    utilization = null
  } = {}) {
    if (!targetId) throw new Error("targetId is required");
    if (outcome === "pending") return null;

    const normalizedTenantId = normalizeTenantId(tenantId);
    const utilizationBand = utilizationBandFor(utilization, config.utilizationBands);
    const key = keyFor(normalizedTenantId, targetId, workloadType, utilizationBand);
    const current = observations.get(key) || {
      tenantId: normalizedTenantId,
      targetId: String(targetId),
      workloadType: String(workloadType),
      utilizationBand,
      samples: 0,
      latencyFactor: null,
      costFactor: null
    };

    const estimatedLatency = finite(estimatedLatencyMs);
    const actualLatency = finite(actualLatencyMs);
    const estimatedCost = finite(estimatedCostUsd);
    const actualCost = finite(actualCostUsd);

    let useful = false;

    if (estimatedLatency != null && estimatedLatency > 0 && actualLatency != null && actualLatency >= 0) {
      current.latencyFactor = updateFactor(
        current.latencyFactor,
        actualLatency / estimatedLatency,
        config.alpha,
        config.minFactor,
        config.maxFactor
      );
      useful = true;
    }

    if (estimatedCost != null && estimatedCost > 0 && actualCost != null && actualCost >= 0) {
      current.costFactor = updateFactor(
        current.costFactor,
        actualCost / estimatedCost,
        config.alpha,
        config.minFactor,
        config.maxFactor
      );
      useful = true;
    }

    if (useful) {
      current.samples += 1;
      observations.set(key, current);
    }

    return current.samples > 0 ? { ...current } : null;
  }

  function hydrate(events = []) {
    if (!Array.isArray(events)) throw new Error("events must be an array");
    for (const event of events) {
      if (event?.outcome === "success" || event?.outcome === "failure") {
        observe({
          tenantId: event.tenantId,
          targetId: event.targetId,
          workloadType: event.workloadType,
          estimatedLatencyMs: event.estimatedLatencyMs,
          actualLatencyMs: event.actualLatencyMs,
          estimatedCostUsd: event.estimatedCostUsd,
          actualCostUsd: event.actualCostUsd,
          outcome: event.outcome,
          utilization: event.targetUtilization
        
        });
      }
    }
    return snapshot();
  }

  function get(targetId, workloadType = "unknown", utilization = null, tenantId = DEFAULT_TENANT_ID) {
    const normalizedTenantId = normalizeTenantId(tenantId);
    const band = utilizationBandFor(utilization, config.utilizationBands);
    const exact = observations.get(keyFor(normalizedTenantId, targetId, workloadType, band));
    const fallback = band === "unknown"
      ? null
      : observations.get(keyFor(normalizedTenantId, targetId, workloadType, "unknown"));
    const item = exact || fallback;
    return item ? { ...item } : null;
  }

  function apply(targets = [], workloadType = "unknown", tenantId = DEFAULT_TENANT_ID) {
    if (!Array.isArray(targets)) throw new Error("targets must be an array");

    return targets.map(target => {
      const item = get(target?.id, workloadType, target?.capacity, tenantId);
      if (!item || item.samples < config.minSamples) {
        return structuredClone(target);
      }

      const adjusted = { ...target };
      if (item.latencyFactor != null && finite(target.estimatedLatencyMs) != null) {
        adjusted.estimatedLatencyMs = Number(
          (Number(target.estimatedLatencyMs) * item.latencyFactor).toFixed(2)
        );
      }
      if (item.costFactor != null && finite(target.estimatedCostUsd) != null) {
        adjusted.estimatedCostUsd = Number(
          (Number(target.estimatedCostUsd) * item.costFactor).toFixed(6)
        );
      }
      return adjusted;
    });
  }

  function snapshot(tenantId = null) {
    const normalizedTenantId = tenantId == null ? null : normalizeTenantId(tenantId);
    return [...observations.values()]
      .filter(item => normalizedTenantId == null || item.tenantId === normalizedTenantId)
      .map(item => ({ ...item }))
      .sort((a, b) =>
        String(a.tenantId).localeCompare(String(b.tenantId)) ||
        String(a.targetId).localeCompare(String(b.targetId)) ||
        String(a.workloadType).localeCompare(String(b.workloadType)) ||
        String(a.utilizationBand).localeCompare(String(b.utilizationBand))
      );
  }

  function clear() {
    observations.clear();
  }

  return {
    observe,
    hydrate,
    get,
    apply,
    snapshot,
    clear,
    config: { ...config }
  };
}

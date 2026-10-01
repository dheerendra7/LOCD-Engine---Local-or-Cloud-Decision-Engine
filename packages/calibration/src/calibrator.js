const DEFAULT_ALPHA = 0.25;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_MIN_FACTOR = 0.25;
const DEFAULT_MAX_FACTOR = 4;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function keyFor(targetId, workloadType) {
  return String(targetId) + "::" + String(workloadType || "unknown");
}

function clampFactor(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validateOptions({
  alpha = DEFAULT_ALPHA,
  minSamples = DEFAULT_MIN_SAMPLES,
  minFactor = DEFAULT_MIN_FACTOR,
  maxFactor = DEFAULT_MAX_FACTOR
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
  return { alpha, minSamples, minFactor, maxFactor };
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
    targetId,
    workloadType = "unknown",
    estimatedLatencyMs,
    actualLatencyMs,
    estimatedCostUsd,
    actualCostUsd,
    outcome
  } = {}) {
    if (!targetId) throw new Error("targetId is required");
    if (outcome === "pending") return null;

    const key = keyFor(targetId, workloadType);
    const current = observations.get(key) || {
      targetId: String(targetId),
      workloadType: String(workloadType),
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
          targetId: event.targetId,
          workloadType: event.workloadType,
          estimatedLatencyMs: event.estimatedLatencyMs,
          actualLatencyMs: event.actualLatencyMs,
          estimatedCostUsd: event.estimatedCostUsd,
          actualCostUsd: event.actualCostUsd,
          outcome: event.outcome
        });
      }
    }
    return snapshot();
  }

  function get(targetId, workloadType = "unknown") {
    const item = observations.get(keyFor(targetId, workloadType));
    return item ? { ...item } : null;
  }

  function apply(targets = [], workloadType = "unknown") {
    if (!Array.isArray(targets)) throw new Error("targets must be an array");

    return targets.map(target => {
      const item = get(target?.id, workloadType);
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

  function snapshot() {
    return [...observations.values()].map(item => ({ ...item }));
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

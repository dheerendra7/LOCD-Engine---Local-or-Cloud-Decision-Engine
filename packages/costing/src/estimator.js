const UNITS = new Set(["flat", "per-request", "per-1k-tokens"]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value, field) {
  const number = finite(value);
  if (number == null || number < 0) throw new Error(field + " must be a non-negative number");
  return number;
}

function positiveIntegerOrZero(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(field + " must be a non-negative integer");
  }
  return number;
}

function normalizePricing(pricing = {}) {
  if (!pricing || typeof pricing !== "object") {
    throw new Error("target.pricing must be an object");
  }

  const unit = String(pricing.unit || "");
  if (!UNITS.has(unit)) {
    throw new Error("target.pricing.unit must be flat, per-request or per-1k-tokens");
  }

  const currency = String(pricing.currency || "USD").toUpperCase();
  if (currency !== "USD") {
    throw new Error("only USD pricing is supported in V1");
  }

  return {
    unit,
    currency,
    flatUsd: pricing.flatUsd == null ? 0 : nonNegative(pricing.flatUsd, "target.pricing.flatUsd"),
    requestUsd: pricing.requestUsd == null ? 0 : nonNegative(pricing.requestUsd, "target.pricing.requestUsd"),
    inputUsdPer1kTokens: pricing.inputUsdPer1kTokens == null
      ? 0
      : nonNegative(pricing.inputUsdPer1kTokens, "target.pricing.inputUsdPer1kTokens"),
    outputUsdPer1kTokens: pricing.outputUsdPer1kTokens == null
      ? 0
      : nonNegative(pricing.outputUsdPer1kTokens, "target.pricing.outputUsdPer1kTokens")
  };
}

export function estimateWorkloadCost({ workload = {}, target = {} } = {}) {
  const explicit = finite(target.estimatedCostUsd);
  if (explicit != null && explicit >= 0) {
    return {
      costUsd: explicit,
      source: "explicit",
      reason: "target_estimated_cost"
    };
  }

  if (!target.pricing) {
    return {
      costUsd: null,
      source: "unknown",
      reason: "target_pricing_missing"
    };
  }

  const pricing = normalizePricing(target.pricing);
  const requests = positiveIntegerOrZero(workload.requests ?? 1, "workload.requests");
  const inputTokens = positiveIntegerOrZero(workload.inputTokens ?? 0, "workload.inputTokens");
  const outputTokens = positiveIntegerOrZero(workload.outputTokens ?? 0, "workload.outputTokens");

  if (pricing.unit === "flat") {
    return {
      costUsd: pricing.flatUsd,
      source: "pricing",
      reason: "flat_pricing"
    };
  }

  if (pricing.unit === "per-request") {
    return {
      costUsd: Number((pricing.requestUsd * Math.max(requests, 1)).toFixed(6)),
      source: "pricing",
      reason: "per_request_pricing"
    };
  }

  const cost =
    inputTokens / 1000 * pricing.inputUsdPer1kTokens +
    outputTokens / 1000 * pricing.outputUsdPer1kTokens;

  return {
    costUsd: Number(cost.toFixed(6)),
    source: "pricing",
    reason: "token_pricing"
  };
}

export function applyCostEstimates(targets = [], workload = {}) {
  if (!Array.isArray(targets)) throw new Error("targets must be an array");

  return targets.map(target => {
    const estimate = estimateWorkloadCost({ workload, target });
    if (estimate.costUsd == null || target.estimatedCostUsd != null) {
      return structuredClone(target);
    }

    return {
      ...structuredClone(target),
      estimatedCostUsd: estimate.costUsd
    };
  });
}

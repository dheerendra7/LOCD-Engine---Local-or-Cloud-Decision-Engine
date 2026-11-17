const UNITS = new Set(["flat", "per-request", "per-1k-tokens"]);

function missingValue(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function finite(value) {
  if (missingValue(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value, field) {
  const number = finite(value);
  if (number == null || number < 0) throw new Error(field + " must be a non-negative number");
  return number;
}

function positiveIntegerOrZero(value, field) {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(field + " must be a non-negative integer");
  }
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

  const requiredFields = {
    flat: ["flatUsd"],
    "per-request": ["requestUsd"],
    "per-1k-tokens": ["inputUsdPer1kTokens", "outputUsdPer1kTokens"]
  }[unit];
  for (const field of requiredFields) {
    if (missingValue(pricing[field])) {
      throw new Error("target.pricing." + field + " is required for " + unit + " pricing");
    }
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
  // Validate supplied usage values even when the selected pricing unit does not
  // consume them. Missing token counts remain valid for flat/per-request pricing.
  const inputTokens = missingValue(workload.inputTokens)
    ? null
    : positiveIntegerOrZero(workload.inputTokens, "workload.inputTokens");
  const outputTokens = missingValue(workload.outputTokens)
    ? null
    : positiveIntegerOrZero(workload.outputTokens, "workload.outputTokens");
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

  if (pricing.unit === "flat") {
    return {
      costUsd: pricing.flatUsd,
      source: "pricing",
      reason: "flat_pricing"
    };
  }

  if (pricing.unit === "per-request") {
    const requests = positiveIntegerOrZero(workload.requests ?? 1, "workload.requests");
    return {
      costUsd: Number((pricing.requestUsd * requests).toFixed(6)),
      source: "pricing",
      reason: "per_request_pricing"
    };
  }

  if (
    missingValue(workload.inputTokens) ||
    missingValue(workload.outputTokens)
  ) {
    return {
      costUsd: null,
      source: "unknown",
      reason: "token_usage_missing"
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
    const explicit = finite(target.estimatedCostUsd);
    if (estimate.costUsd == null || (explicit != null && explicit >= 0)) {
      return structuredClone(target);
    }

    return {
      ...structuredClone(target),
      estimatedCostUsd: estimate.costUsd
    };
  });
}

const MODES = ["local", "private", "cloud", "hybrid"];
const SENSITIVITY_LEVELS = { low: 0, medium: 0.5, high: 1 };

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value)));
}

function unique(values) {
  return [...new Set(values || [])];
}

function normalizePolicy(policy = {}) {
  return {
    allowedModes: unique(policy.allowedModes?.length ? policy.allowedModes : MODES),
    allowedRegions: unique(policy.allowedRegions || []),
    sensitiveDataMode: policy.sensitiveDataMode || "balanced",
    weights: {
      privacy: clamp(policy.weights?.privacy ?? 0.30),
      latency: clamp(policy.weights?.latency ?? 0.25),
      cost: clamp(policy.weights?.cost ?? 0.20),
      capacity: clamp(policy.weights?.capacity ?? 0.10),
      reliability: clamp(policy.weights?.reliability ?? 0.15)
    }
  };
}

function normalizeRequest(input) {
  if (!input || typeof input !== "object") throw new Error("request must be an object");
  if (!input.workload?.type) throw new Error("workload.type is required");
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error("targets must be a non-empty array");
  }

  return {
    workload: {
      type: input.workload.type,
      sensitivity: input.workload.sensitivity || "low",
      requiredCapabilities: unique(input.workload.requiredCapabilities)
    },
    constraints: {
      latencyBudgetMs: input.constraints?.latencyBudgetMs ?? null,
      maxCostUsd: input.constraints?.maxCostUsd ?? null,
      strictLatency: Boolean(input.constraints?.strictLatency),
      strictCost: Boolean(input.constraints?.strictCost)
    },
    targets: input.targets,
    policy: normalizePolicy(input.policy)
  };
}

function privacyFit(sensitivity, target, policy) {
  const required = SENSITIVITY_LEVELS[sensitivity] ?? 0;
  const privacy = clamp(target.privacy ?? 0);

  if (sensitivity === "high" && policy.sensitiveDataMode === "local-only" && target.mode !== "local") {
    return { eligible: false, reason: "sensitive_workload_requires_local_execution" };
  }
  if (sensitivity === "high" && policy.sensitiveDataMode === "private-only" &&
      !["local", "private"].includes(target.mode)) {
    return { eligible: false, reason: "sensitive_workload_requires_private_boundary" };
  }

  return { eligible: true, score: clamp(privacy + (1 - required) * 0.1) };
}

function capabilityCheck(required, target) {
  const available = new Set(target.capabilities || []);
  const missing = required.find(cap => !available.has(cap));
  return missing
    ? { eligible: false, reason: "missing_required_capability:" + missing }
    : { eligible: true };
}

function residencyCheck(allowedRegions, target) {
  if (!allowedRegions.length) return { eligible: true };
  const regions = new Set(target.regions || []);
  return allowedRegions.some(region => regions.has(region))
    ? { eligible: true }
    : { eligible: false, reason: "data_residency_mismatch" };
}

function evaluateCandidate(request, target) {
  const rejected = [];
  const { constraints, workload, policy } = request;

  if (!target?.id) rejected.push("target_id_missing");
  if (target?.available === false) rejected.push("target_unavailable");
  if (!MODES.includes(target?.mode)) rejected.push("invalid_target_mode");
  if (!policy.allowedModes.includes(target?.mode)) rejected.push("mode_not_allowed");

  const capability = capabilityCheck(workload.requiredCapabilities, target);
  if (!capability.eligible) rejected.push(capability.reason);

  const residency = residencyCheck(policy.allowedRegions, target);
  if (!residency.eligible) rejected.push(residency.reason);

  const privacy = privacyFit(workload.sensitivity, target, policy);
  if (!privacy.eligible) rejected.push(privacy.reason);

  if (constraints.strictLatency &&
      Number.isFinite(constraints.latencyBudgetMs) &&
      Number(target.estimatedLatencyMs) > constraints.latencyBudgetMs) {
    rejected.push("latency_budget_exceeded");
  }

  if (constraints.strictCost &&
      Number.isFinite(constraints.maxCostUsd) &&
      Number(target.estimatedCostUsd) > constraints.maxCostUsd) {
    rejected.push("cost_budget_exceeded");
  }

  if (rejected.length) {
    return { eligible: false, targetId: target.id ?? null, target, rejected };
  }

  const latency = Number.isFinite(target.estimatedLatencyMs)
    ? clamp(1 - target.estimatedLatencyMs / Math.max(constraints.latencyBudgetMs || target.estimatedLatencyMs * 2, 1))
    : 0;

  const cost = Number.isFinite(target.estimatedCostUsd)
    ? clamp(constraints.maxCostUsd == null
        ? 1 - clamp(target.estimatedCostUsd / Math.max(target.estimatedCostUsd * 2, 0.01))
        : 1 - target.estimatedCostUsd / Math.max(constraints.maxCostUsd, 0.000001))
    : 0;

  const capacity = clamp(1 - Number(target.capacity ?? 1));

  const score =
    privacy.score * policy.weights.privacy +
    latency * policy.weights.latency +
    cost * policy.weights.cost +
    capacity * policy.weights.capacity +
    clamp(target.health ?? 0) * policy.weights.reliability;

  return {
    eligible: true,
    targetId: target.id,
    target,
    score: clamp(score),
    factors: { privacy: privacy.score, latency, cost, capacity, reliability: clamp(target.health ?? 0) }
  };
}

function makeConfidence(ranked) {
  if (ranked.length === 0) return 0;
  if (ranked.length === 1) return 1;
  const margin = ranked[0].score - ranked[1].score;
  return clamp(0.5 + margin * 2);
}

export function decide(input) {
  const request = normalizeRequest(input);
  const evaluations = request.targets.map(target => evaluateCandidate(request, target));
  const eligible = evaluations
    .filter(item => item.eligible)
    .sort((a, b) => b.score - a.score || String(a.targetId).localeCompare(String(b.targetId)));

  if (!eligible.length) {
    return {
      route: "none",
      targetId: null,
      confidence: 0,
      score: 0,
      estimated: null,
      reasons: ["no_eligible_target"],
      alternatives: [],
      rejected: evaluations.map(({ targetId, rejected }) => ({ targetId, reasons: rejected }))
    };
  }

  const winner = eligible[0];
  const reasons = [
    winner.factors.privacy >= 0.7 ? "strong_privacy_fit" : null,
    winner.factors.latency >= 0.7 ? "latency_fit" : null,
    winner.factors.cost >= 0.7 ? "cost_fit" : null,
    winner.factors.capacity >= 0.7 ? "capacity_headroom" : null,
    winner.factors.reliability >= 0.95 ? "high_reliability_signal" : null
  ].filter(Boolean);

  return {
    route: winner.target.mode,
    targetId: winner.targetId,
    confidence: makeConfidence(eligible),
    score: Number(winner.score.toFixed(6)),
    estimated: {
      latencyMs: winner.target.estimatedLatencyMs ?? null,
      costUsd: winner.target.estimatedCostUsd ?? null
    },
    reasons,
    alternatives: eligible.slice(1).map(item => ({
      targetId: item.targetId,
      route: item.target.mode,
      score: Number(item.score.toFixed(6))
    })),
    rejected: evaluations
      .filter(item => !item.eligible)
      .map(({ targetId, rejected }) => ({ targetId, reasons: rejected }))
  };
}

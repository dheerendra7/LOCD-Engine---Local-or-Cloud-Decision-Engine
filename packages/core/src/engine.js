const MODES = ["local", "private", "cloud", "hybrid"];
const SENSITIVITIES = ["low", "medium", "high"];
const SENSITIVITY_LEVELS = { low: 0, medium: 0.5, high: 1 };
const SENSITIVE_MODES = ["balanced", "prefer-local", "local-only", "private-only"];

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function unique(values) {
  return [...new Set(Array.isArray(values) ? values : [])];
}

function normalizePolicy(policy = {}) {
  const sensitiveDataMode = policy.sensitiveDataMode || "balanced";
  if (!SENSITIVE_MODES.includes(sensitiveDataMode)) {
    throw new Error("policy.sensitiveDataMode must be one of: " + SENSITIVE_MODES.join(", "));
  }

  return {
    allowedModes: unique(policy.allowedModes?.length ? policy.allowedModes : MODES),
    allowedRegions: unique(policy.allowedRegions || []),
    blockedModes: unique(policy.blockedModes || []),
    sensitiveDataMode,
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

  const sensitivity = input.workload.sensitivity || "low";
  if (!SENSITIVITIES.includes(sensitivity)) {
    throw new Error("workload.sensitivity must be one of: " + SENSITIVITIES.join(", "));
  }

  const constraints = {
    latencyBudgetMs: finiteOrNull(input.constraints?.latencyBudgetMs),
    maxCostUsd: finiteOrNull(input.constraints?.maxCostUsd),
    strictLatency: Boolean(input.constraints?.strictLatency),
    strictCost: Boolean(input.constraints?.strictCost)
  };

  if (constraints.latencyBudgetMs !== null && constraints.latencyBudgetMs < 0) {
    throw new Error("constraints.latencyBudgetMs must be >= 0");
  }
  if (constraints.maxCostUsd !== null && constraints.maxCostUsd < 0) {
    throw new Error("constraints.maxCostUsd must be >= 0");
  }

  return {
    workload: {
      type: String(input.workload.type),
      sensitivity,
      requiredCapabilities: unique(input.workload.requiredCapabilities)
    },
    constraints,
    targets: input.targets,
    policy: normalizePolicy(input.policy)
  };
}

function privacyFit(sensitivity, target, policy) {
  const required = SENSITIVITY_LEVELS[sensitivity];
  const privacy = clamp(target.privacy ?? 0);

  if (sensitivity === "high" && policy.sensitiveDataMode === "local-only" && target.mode !== "local") {
    return { eligible: false, reason: "sensitive_workload_requires_local_execution", score: 0 };
  }

  if (sensitivity === "high" && policy.sensitiveDataMode === "private-only" &&
      !["local", "private"].includes(target.mode)) {
    return { eligible: false, reason: "sensitive_workload_requires_private_boundary", score: 0 };
  }

  let score = privacy + (1 - required) * 0.1;
  if (sensitivity === "high" && policy.sensitiveDataMode === "prefer-local" && target.mode === "local") {
    score += 0.25;
  }

  return { eligible: true, score: clamp(score) };
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

  if (!target || typeof target !== "object") {
    return { eligible: false, targetId: null, target, rejected: ["invalid_target"] };
  }

  if (!target.id) rejected.push("target_id_missing");
  if (target.available === false) rejected.push("target_unavailable");
  if (!MODES.includes(target.mode)) rejected.push("invalid_target_mode");
  if (!policy.allowedModes.includes(target.mode)) rejected.push("mode_not_allowed");
  if (policy.blockedModes.includes(target.mode)) rejected.push("mode_blocked");

  const capability = capabilityCheck(workload.requiredCapabilities, target);
  if (!capability.eligible) rejected.push(capability.reason);

  const residency = residencyCheck(policy.allowedRegions, target);
  if (!residency.eligible) rejected.push(residency.reason);

  const privacy = privacyFit(workload.sensitivity, target, policy);
  if (!privacy.eligible) rejected.push(privacy.reason);

  const estimatedLatencyMs = finiteOrNull(target.estimatedLatencyMs);
  const estimatedCostUsd = finiteOrNull(target.estimatedCostUsd);
  const health = clamp(target.health ?? 0);
  const capacity = clamp(target.capacity ?? 1);

  if (constraints.strictLatency && constraints.latencyBudgetMs !== null) {
    if (estimatedLatencyMs === null) {
      rejected.push("latency_estimate_missing");
    } else if (estimatedLatencyMs > constraints.latencyBudgetMs) {
      rejected.push("latency_budget_exceeded");
    }
  }

  if (constraints.strictCost && constraints.maxCostUsd !== null) {
    if (estimatedCostUsd === null) {
      rejected.push("cost_estimate_missing");
    } else if (estimatedCostUsd > constraints.maxCostUsd) {
      rejected.push("cost_budget_exceeded");
    }
  }

  if (rejected.length) {
    return { eligible: false, targetId: target.id ?? null, target, rejected };
  }

  const latency = estimatedLatencyMs === null
    ? 0
    : clamp(1 - estimatedLatencyMs / Math.max(constraints.latencyBudgetMs || estimatedLatencyMs * 2, 1));

  const cost = estimatedCostUsd === null
    ? 0
    : clamp(constraints.maxCostUsd === null
        ? 1 - clamp(estimatedCostUsd / Math.max(estimatedCostUsd * 2, 0.01))
        : 1 - estimatedCostUsd / Math.max(constraints.maxCostUsd, 0.000001));

  const headroom = clamp(1 - capacity);

  const score =
    privacy.score * policy.weights.privacy +
    latency * policy.weights.latency +
    cost * policy.weights.cost +
    headroom * policy.weights.capacity +
    health * policy.weights.reliability;

  return {
    eligible: true,
    targetId: target.id,
    target,
    score: clamp(score),
    factors: {
      privacy: privacy.score,
      latency,
      cost,
      capacity: headroom,
      reliability: health
    }
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
  const ids = new Set();
  for (const target of request.targets) {
    if (target?.id && ids.has(String(target.id))) {
      throw new Error("target ids must be unique");
    }
    if (target?.id) ids.add(String(target.id));
  }

  const evaluations = request.targets.map(target => evaluateCandidate(request, target));
  const eligible = evaluations
    .filter(item => item.eligible)
    .sort((a, b) => b.score - a.score || String(a.targetId).localeCompare(String(b.targetId)));

  if (!eligible.length) {
    return {
      decisionVersion: "1.0",
      route: "none",
      targetId: null,
      confidence: 0,
      score: 0,
      estimated: null,
      reasons: ["no_eligible_target"],
      alternatives: [],
      rejected: evaluations.map(({ targetId, rejected }) => ({ targetId, reasons: rejected })),
      evaluated: evaluations.map(item => ({
        targetId: item.targetId,
        mode: item.target?.mode ?? null,
        eligible: false,
        reasons: item.rejected
      }))
    };
  }

  const winner = eligible[0];
  const reasons = [
    winner.factors.privacy >= 0.7 ? "strong_privacy_fit" : null,
    winner.factors.latency >= 0.7 ? "latency_fit" : null,
    winner.factors.cost >= 0.7 ? "cost_fit" : null,
    winner.factors.capacity >= 0.7 ? "capacity_headroom" : null,
    winner.factors.reliability >= 0.95 ? "high_reliability_signal" : null,
    request.policy.sensitiveDataMode === "prefer-local" && winner.target.mode === "local"
      ? "local_preference_applied"
      : null
  ].filter(Boolean);

  return {
    decisionVersion: "1.0",
    route: winner.target.mode,
    targetId: winner.targetId,
    confidence: Number(makeConfidence(eligible).toFixed(6)),
    score: Number(winner.score.toFixed(6)),
    estimated: {
      latencyMs: finiteOrNull(winner.target.estimatedLatencyMs),
      costUsd: finiteOrNull(winner.target.estimatedCostUsd)
    },
    reasons,
    alternatives: eligible.slice(1).map(item => ({
      targetId: item.targetId,
      route: item.target.mode,
      score: Number(item.score.toFixed(6))
    })),
    rejected: evaluations
      .filter(item => !item.eligible)
      .map(({ targetId, rejected }) => ({ targetId, reasons: rejected })),
    evaluated: evaluations.map(item => ({
      targetId: item.targetId,
      mode: item.target?.mode ?? null,
      eligible: item.eligible,
      score: item.eligible ? Number(item.score.toFixed(6)) : null,
      factors: item.eligible ? item.factors : null,
      reasons: item.eligible ? [] : item.rejected
    }))
  };
}

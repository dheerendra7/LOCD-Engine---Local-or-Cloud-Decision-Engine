import { resolvePolicy } from "../../../packages/policy/src/index.js";
import { estimateWorkloadCost } from "../../../packages/costing/src/index.js";

const MODES = ["local", "private", "cloud", "hybrid"];
const SENSITIVITIES = ["low", "medium", "high"];
const SENSITIVITY_LEVELS = { low: 0, medium: 0.5, high: 1 };
const SENSITIVE_MODES = ["balanced", "prefer-local", "local-only", "private-only"];

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function missingValue(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function finiteOrNull(value) {
  if (missingValue(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumberOrNull(value, field) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(field + " must be >= 0");
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(field + " must be >= 0");
  }
  return number;
}

function unique(values) {
  return [...new Set(Array.isArray(values) ? values : [])];
}

function nonNegativeInteger(value, field) {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(field + " must be a non-negative integer");
  }
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(field + " must be a non-negative integer");
  }
  return number;
}

function normalizePolicy(policy = {}, workload = {}) {
  const resolved = resolvePolicy(policy, { workload });
  const sensitiveDataMode = resolved.sensitiveDataMode || "balanced";
  if (!SENSITIVE_MODES.includes(sensitiveDataMode)) {
    throw new Error("policy.sensitiveDataMode must be one of: " + SENSITIVE_MODES.join(", "));
  }

  return {
    allowedModes: unique(resolved.allowedModes?.length ? resolved.allowedModes : MODES),
    allowedRegions: unique(resolved.allowedRegions || []),
    blockedModes: unique(resolved.blockedModes || []),
    sensitiveDataMode,
    weights: {
      privacy: clamp(resolved.weights?.privacy ?? 0.30),
      latency: clamp(resolved.weights?.latency ?? 0.25),
      cost: clamp(resolved.weights?.cost ?? 0.20),
      capacity: clamp(resolved.weights?.capacity ?? 0.10),
      reliability: clamp(resolved.weights?.reliability ?? 0.15)
    },
    maxHeartbeatAgeMs: nonNegativeNumberOrNull(resolved.maxHeartbeatAgeMs, "policy.maxHeartbeatAgeMs"),
    matchedRules: Array.isArray(resolved.matchedRules) ? [...resolved.matchedRules] : []
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
    latencyBudgetMs: nonNegativeNumberOrNull(input.constraints?.latencyBudgetMs, "constraints.latencyBudgetMs"),
    maxCostUsd: nonNegativeNumberOrNull(input.constraints?.maxCostUsd, "constraints.maxCostUsd"),
    strictLatency: Boolean(input.constraints?.strictLatency),
    strictCost: Boolean(input.constraints?.strictCost)
  };

  const requiredMemoryGb = nonNegativeNumberOrNull(input.workload.requiredMemoryGb, "workload.requiredMemoryGb");
  const requiredContextTokens = nonNegativeNumberOrNull(input.workload.requiredContextTokens, "workload.requiredContextTokens");

  if (constraints.latencyBudgetMs !== null && constraints.latencyBudgetMs < 0) {
    throw new Error("constraints.latencyBudgetMs must be >= 0");
  }
  if (constraints.maxCostUsd !== null && constraints.maxCostUsd < 0) {
    throw new Error("constraints.maxCostUsd must be >= 0");
  }
  if (requiredMemoryGb !== null && requiredMemoryGb < 0) {
    throw new Error("workload.requiredMemoryGb must be >= 0");
  }
  if (requiredContextTokens !== null && requiredContextTokens < 0) {
    throw new Error("workload.requiredContextTokens must be >= 0");
  }

  const policy = normalizePolicy(input.policy, input.workload);
  if (policy.maxHeartbeatAgeMs !== null && policy.maxHeartbeatAgeMs < 0) {
    throw new Error("policy.maxHeartbeatAgeMs must be >= 0");
  }

  return {
    workload: {
      type: String(input.workload.type),
      sensitivity,
      requiredCapabilities: unique(input.workload.requiredCapabilities),
      requiredMemoryGb,
      requiredContextTokens,
      inputTokens: missingValue(input.workload.inputTokens)
        ? null
        : nonNegativeInteger(input.workload.inputTokens, "workload.inputTokens"),
      outputTokens: missingValue(input.workload.outputTokens)
        ? null
        : nonNegativeInteger(input.workload.outputTokens, "workload.outputTokens"),
      requests: nonNegativeInteger(input.workload.requests ?? 1, "workload.requests")
    },
    constraints,
    targets: input.targets,
    policy
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

function weightedScore(factors, weights) {
  return clamp(
    factors.privacy * weights.privacy +
    factors.latency * weights.latency +
    factors.cost * weights.cost +
    factors.capacity * weights.capacity +
    factors.reliability * weights.reliability
  );
}

function applyRelativeCostScoring(candidates, request) {
  // An explicit budget already gives cost a meaningful absolute reference.
  if (request.constraints.maxCostUsd !== null) return;

  const priced = candidates.filter(candidate =>
    Number.isFinite(candidate.costEstimate?.usd) &&
    candidate.costEstimate.usd >= 0
  );
  if (priced.length < 2) return;

  const costs = priced.map(candidate => candidate.costEstimate.usd);
  const minimum = Math.min(...costs);
  const maximum = Math.max(...costs);
  if (maximum <= minimum) return;

  // Without a budget, compare known prices only against other eligible,
  // priced candidates. Unknown estimates never distort the scale.
  for (const candidate of priced) {
    candidate.factors.cost = clamp(
      (maximum - candidate.costEstimate.usd) / (maximum - minimum)
    );
    candidate.score = weightedScore(candidate.factors, request.policy.weights);
  }
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

  const rawEstimatedLatencyMs = finiteOrNull(target.estimatedLatencyMs);
  const estimatedLatencyMs = rawEstimatedLatencyMs != null && rawEstimatedLatencyMs < 0
    ? null
    : rawEstimatedLatencyMs;
  const costEstimate = estimateWorkloadCost({
    workload,
    target
  });
  const estimatedCostUsd = costEstimate.costUsd;
  const rawCapacity = finiteOrNull(target.capacity);
  const health = clamp(missingValue(target.health) ? 0 : target.health);
  const capacity = rawCapacity === null ? 1 : clamp(rawCapacity);
  if (rawCapacity !== null && rawCapacity < 0) {
    rejected.push("invalid_capacity_telemetry");
  }
  const availableMemoryGb = finiteOrNull(target.availableMemoryGb);
  const heartbeatAt = target.lastHeartbeatAt ? new Date(target.lastHeartbeatAt).getTime() : null;

  if (policy.maxHeartbeatAgeMs !== null) {
    if (heartbeatAt === null || !Number.isFinite(heartbeatAt)) {
      rejected.push("heartbeat_staleness_unknown");
    } else if (Date.now() - heartbeatAt > policy.maxHeartbeatAgeMs) {
      rejected.push("target_heartbeat_stale");
    }
  }
  const maxContextTokens = finiteOrNull(target.maxContextTokens);

  if (availableMemoryGb !== null && availableMemoryGb < 0) {
    rejected.push("invalid_memory_telemetry");
  }
  if (maxContextTokens !== null && maxContextTokens < 0) {
    rejected.push("invalid_context_telemetry");
  }

  if (workload.requiredMemoryGb !== null) {
    if (availableMemoryGb === null) {
      rejected.push("memory_capacity_unknown");
    } else if (availableMemoryGb >= 0 && availableMemoryGb < workload.requiredMemoryGb) {
      rejected.push("memory_capacity_exceeded");
    }
  }

  if (workload.requiredContextTokens !== null) {
    if (maxContextTokens === null) {
      rejected.push("context_capacity_unknown");
    } else if (maxContextTokens >= 0 && maxContextTokens < workload.requiredContextTokens) {
      rejected.push("context_capacity_exceeded");
    }
  }

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

  const factors = {
    privacy: privacy.score,
    latency,
    cost,
    capacity: headroom,
    reliability: health
  };
  const score = weightedScore(factors, policy.weights);

  return {
    eligible: true,
    targetId: target.id,
    target,
    score,
    estimatedLatencyMs,
    factors,
    costEstimate: {
      usd: estimatedCostUsd,
      source: costEstimate.source,
      reason: costEstimate.reason
    },
    capacity: {
      availableMemoryGb,
      maxContextTokens
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
  const eligible = evaluations.filter(item => item.eligible);
  applyRelativeCostScoring(eligible, request);
  eligible.sort((a, b) => b.score - a.score || String(a.targetId).localeCompare(String(b.targetId)));

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
      policyRulesApplied: request.policy.matchedRules,
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
      : null,
    ...request.policy.matchedRules.map(id => "policy_rule_applied:" + id)
  ].filter(Boolean);

  return {
    decisionVersion: "1.0",
    route: winner.target.mode,
    targetId: winner.targetId,
    confidence: Number(makeConfidence(eligible).toFixed(6)),
    score: Number(winner.score.toFixed(6)),
    estimated: {
      latencyMs: winner.estimatedLatencyMs,
      costUsd: winner.costEstimate.usd
    },
    reasons,
    policyRulesApplied: request.policy.matchedRules,
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
      capacity: item.eligible ? item.capacity : null,
      costEstimate: item.eligible ? item.costEstimate : null,
      reasons: item.eligible ? [] : item.rejected
    }))
  };
}

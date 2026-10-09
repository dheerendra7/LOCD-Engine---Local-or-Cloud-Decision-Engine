import { resolvePolicy } from "../../../packages/policy/src/index.js";

const MODES = new Set(["local", "private", "cloud", "hybrid"]);
const SENSITIVITIES = new Set(["low", "medium", "high"]);

function finiteOrNull(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeOrNull(value) {
  const number = finiteOrNull(value);
  return number == null || number < 0 ? null : number;
}

function nonNegativeConstraintOrNull(value, field) {
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

function normalizePlan(input) {
  if (!input || typeof input !== "object") throw new Error("hybrid plan must be an object");
  if (!Array.isArray(input.steps) || input.steps.length < 2) {
    throw new Error("hybrid plan requires at least two steps");
  }
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new Error("hybrid plan targets must be a non-empty array");
  }

  const workloadSensitivity = input.workload?.sensitivity || "low";
  if (!SENSITIVITIES.has(workloadSensitivity)) {
    throw new Error("workload.sensitivity must be one of: low, medium, high");
  }

  const constraints = {
    maxLatencyMs: nonNegativeConstraintOrNull(input.constraints?.maxLatencyMs, "constraints.maxLatencyMs"),
    maxCostUsd: nonNegativeConstraintOrNull(input.constraints?.maxCostUsd, "constraints.maxCostUsd"),
    strictLatency: Boolean(input.constraints?.strictLatency),
    strictCost: Boolean(input.constraints?.strictCost)
  };

  return {
    workload: {
      type: String(input.workload?.type || "unknown"),
      sensitivity: workloadSensitivity
    },
    constraints,
    policy: resolvePolicy(input.policy || {}),
    steps: input.steps.map((step, index) => ({
      id: String(step?.id || ""),
      purpose: String(step?.purpose || "stage-" + index),
      targetId: step?.targetId == null ? "" : String(step.targetId),
      dataSensitivity: step?.dataSensitivity || workloadSensitivity
    })),
    targets: input.targets
  };
}

function policyRejects(policy, target, sensitivity) {
  const reasons = [];
  const allowedModes = Array.isArray(policy.allowedModes) && policy.allowedModes.length
    ? policy.allowedModes
    : [...MODES];
  const blockedModes = Array.isArray(policy.blockedModes)
    ? policy.blockedModes
    : [];
  const allowedRegions = Array.isArray(policy.allowedRegions)
    ? policy.allowedRegions
    : [];

  if (!MODES.has(target.mode)) reasons.push("invalid_target_mode");
  if (!allowedModes.includes(target.mode)) reasons.push("mode_not_allowed");
  if (blockedModes.includes(target.mode)) reasons.push("mode_blocked");

  if (sensitivity === "high" && policy.sensitiveDataMode === "local-only" && target.mode !== "local") {
    reasons.push("sensitive_stage_requires_local_execution");
  }

  if (sensitivity === "high" && policy.sensitiveDataMode === "private-only" &&
      !["local", "private"].includes(target.mode)) {
    reasons.push("sensitive_stage_requires_private_boundary");
  }

  if (allowedRegions.length) {
    const regions = new Set(target.regions || []);
    if (!allowedRegions.some(region => regions.has(region))) {
      reasons.push("data_residency_mismatch");
    }
  }

  return reasons;
}

export function planHybridExecution(input) {
  const request = normalizePlan(input);
  const targetMap = new Map();
  const stepIds = new Set();
  const rejected = [];
  const steps = [];
  let totalLatencyMs = 0;
  let totalCostUsd = 0;
  let totalLatencyKnown = true;
  let totalCostKnown = true;

  for (const target of request.targets) {
    if (target?.id) targetMap.set(String(target.id), target);
  }

  for (const step of request.steps) {
    if (!step.id) {
      totalLatencyKnown = false;
      totalCostKnown = false;
      rejected.push({ stepId: null, reasons: ["step_id_missing"] });
      continue;
    }
    if (stepIds.has(step.id)) {
      totalLatencyKnown = false;
      totalCostKnown = false;
      rejected.push({ stepId: step.id, reasons: ["duplicate_step_id"] });
      continue;
    }
    stepIds.add(step.id);

    const target = targetMap.get(step.targetId);
    if (!target) {
      totalLatencyKnown = false;
      totalCostKnown = false;
      rejected.push({ stepId: step.id, reasons: ["target_not_found"] });
      continue;
    }

    const reasons = [];
    if (target.available === false) reasons.push("target_unavailable");
    reasons.push(...policyRejects(request.policy, target, step.dataSensitivity));

    const latency = nonNegativeOrNull(target.estimatedLatencyMs);
    const cost = nonNegativeOrNull(target.estimatedCostUsd);

    if (latency === null) totalLatencyKnown = false;
    if (cost === null) totalCostKnown = false;

    if (request.constraints.strictLatency && latency === null) {
      reasons.push("latency_estimate_missing");
    }
    if (request.constraints.strictCost && cost === null) {
      reasons.push("cost_estimate_missing");
    }

    steps.push({
      id: step.id,
      purpose: step.purpose,
      targetId: target.id,
      mode: target.mode,
      dataSensitivity: step.dataSensitivity,
      estimatedLatencyMs: latency,
      estimatedCostUsd: cost
    });

    if (!reasons.length) {
      if (latency != null) totalLatencyMs += latency;
      if (cost != null) totalCostUsd += cost;
    }

    if (reasons.length) {
      // A rejected step is not part of a complete, executable plan estimate.
      totalLatencyKnown = false;
      totalCostKnown = false;
      rejected.push({ stepId: step.id, reasons });
    }
  }

  if (new Set(steps.map(step => step.targetId)).size < 2) {
    rejected.push({
      stepId: null,
      reasons: ["hybrid_plan_requires_multiple_targets"]
    });
  }

  if (request.constraints.strictLatency &&
      request.constraints.maxLatencyMs !== null &&
      totalLatencyMs > request.constraints.maxLatencyMs) {
    rejected.push({ stepId: null, reasons: ["plan_latency_budget_exceeded"] });
  }

  if (request.constraints.strictCost &&
      request.constraints.maxCostUsd !== null &&
      totalCostUsd > request.constraints.maxCostUsd) {
    rejected.push({ stepId: null, reasons: ["plan_cost_budget_exceeded"] });
  }

  return {
    planVersion: "1.0",
    route: "hybrid",
    valid: rejected.length === 0,
    steps,
    estimated: {
      latencyMs: totalLatencyKnown ? Number(totalLatencyMs.toFixed(2)) : null,
      costUsd: totalCostKnown ? Number(totalCostUsd.toFixed(6)) : null
    },
    reasons: rejected.length
      ? ["hybrid_plan_rejected"]
      : ["multi_stage_execution_plan_valid"],
    rejected
  };
}

import { decide } from "./engine.js";

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function setDiff(before = [], after = []) {
  const left = new Set(before.map(String));
  const right = new Set(after.map(String));

  return {
    added: [...right].filter(value => !left.has(value)).sort(),
    removed: [...left].filter(value => !right.has(value)).sort()
  };
}

function delta(after, before) {
  if (after == null || before == null) return null;
  const value = Number(after) - Number(before);
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function summarize(result) {
  return {
    route: result.route,
    targetId: result.targetId,
    score: result.score,
    confidence: result.confidence,
    estimated: result.estimated
      ? {
          latencyMs: finiteOrNull(result.estimated.latencyMs),
          costUsd: finiteOrNull(result.estimated.costUsd)
        }
      : null,
    reasons: [...(result.reasons || [])],
    policyRulesApplied: [...(result.policyRulesApplied || [])]
  };
}

export function simulatePolicy({
  workload,
  constraints = {},
  targets,
  currentPolicy = {},
  candidatePolicy = {}
} = {}) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("targets must be a non-empty array");
  }

  const base = { workload, constraints, targets };
  const current = decide({ ...base, policy: currentPolicy });
  const candidate = decide({ ...base, policy: candidatePolicy });

  const currentRejected = (current.rejected || []).flatMap(item =>
    (item.reasons || []).map(reason => String(reason))
  );
  const candidateRejected = (candidate.rejected || []).flatMap(item =>
    (item.reasons || []).map(reason => String(reason))
  );

  const routeChanged = current.route !== candidate.route;
  const targetChanged = String(current.targetId ?? "") !== String(candidate.targetId ?? "");

  return {
    version: "1.0",
    mutatedState: false,
    executedProvider: false,
    current: summarize(current),
    candidate: summarize(candidate),
    impact: {
      routeChanged,
      targetChanged,
      scoreDelta: delta(candidate.score, current.score),
      confidenceDelta: delta(candidate.confidence, current.confidence),
      latencyDeltaMs: delta(
        candidate.estimated?.latencyMs,
        current.estimated?.latencyMs
      ),
      costDeltaUsd: delta(
        candidate.estimated?.costUsd,
        current.estimated?.costUsd
      ),
      reasons: setDiff(current.reasons || [], candidate.reasons || []),
      policyRules: setDiff(
        current.policyRulesApplied || [],
        candidate.policyRulesApplied || []
      ),
      rejectedReasons: setDiff(currentRejected, candidateRejected)
    },
    recommendation:
      routeChanged || targetChanged
        ? "review_change"
        : "no_routing_change"
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/index.js";

const base = {
  workload: { type: "llm-inference", sensitivity: "high" },
  constraints: { latencyBudgetMs: 800, maxCostUsd: 0.05, strictLatency: true, strictCost: true },
  policy: { sensitiveDataMode: "local-only" },
  targets: [
    { id: "local", mode: "local", health: 0.98, capacity: 0.25, privacy: 1, estimatedLatencyMs: 420, estimatedCostUsd: 0, available: true },
    { id: "cloud", mode: "cloud", health: 0.999, capacity: 0.20, privacy: 0.2, estimatedLatencyMs: 200, estimatedCostUsd: 0.01, available: true }
  ]
};

test("sensitive local-only policy rejects cloud hard", () => {
  const result = decide(base);
  assert.equal(result.route, "local");
  assert.equal(result.targetId, "local");
  assert.deepEqual(result.rejected[0].reasons, ["sensitive_workload_requires_local_execution"]);
});

test("strict latency rejects slow target", () => {
  const input = structuredClone(base);
  input.policy.sensitiveDataMode = "balanced";
  input.targets = [
    { id: "slow", mode: "private", health: 0.99, capacity: 0.1, privacy: 1, estimatedLatencyMs: 1200, estimatedCostUsd: 0.01, available: true }
  ];
  const result = decide(input);
  assert.equal(result.route, "none");
  assert.equal(result.reasons[0], "no_eligible_target");
});

test("strict cost rejects expensive target", () => {
  const input = structuredClone(base);
  input.policy.sensitiveDataMode = "balanced";
  input.targets = [
    { id: "expensive", mode: "cloud", health: 0.99, capacity: 0.1, privacy: 0.5, estimatedLatencyMs: 200, estimatedCostUsd: 1, available: true }
  ];
  const result = decide(input);
  assert.equal(result.route, "none");
  assert.match(result.rejected[0].reasons[0], /cost_budget_exceeded/);
});

test("missing capabilities reject a target", () => {
  const input = structuredClone(base);
  input.policy.sensitiveDataMode = "balanced";
  input.workload.requiredCapabilities = ["vision"];
  input.targets[0].capabilities = ["text-generation"];
  input.targets[1].capabilities = ["text-generation"];
  const result = decide(input);
  assert.equal(result.route, "none");
});

test("residency mismatch is a hard rejection", () => {
  const input = structuredClone(base);
  input.policy.sensitiveDataMode = "balanced";
  input.policy.allowedRegions = ["ap-south-1"];
  input.targets = [
    { id: "us", mode: "cloud", health: 1, capacity: 0.1, privacy: 0.5, estimatedLatencyMs: 200, estimatedCostUsd: 0.01, regions: ["us-east-1"] }
  ];
  const result = decide(input);
  assert.deepEqual(result.rejected[0].reasons, ["data_residency_mismatch"]);
});

test("unavailable targets cannot win", () => {
  const input = structuredClone(base);
  input.policy.sensitiveDataMode = "balanced";
  input.targets[0].available = false;
  const result = decide(input);
  assert.equal(result.targetId, "cloud");
});

test("tie-breaking is deterministic by target id", () => {
  const input = {
    workload: { type: "batch", sensitivity: "low" },
    constraints: {},
    targets: [
      { id: "b", mode: "cloud", health: 1, capacity: 0, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0 },
      { id: "a", mode: "cloud", health: 1, capacity: 0, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0 }
    ]
  };
  const result = decide(input);
  assert.equal(result.targetId, "a");
});

test("malformed requests fail clearly", () => {
  assert.throws(() => decide({}), /workload.type is required/);
  assert.throws(() => decide({ workload: { type: "x" } }), /targets must be a non-empty array/);
});

test("alternatives are returned for eligible targets", () => {
  const input = {
    workload: { type: "batch", sensitivity: "low" },
    constraints: { latencyBudgetMs: 1000 },
    targets: [
      { id: "local", mode: "local", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 200, estimatedCostUsd: 0 },
      { id: "cloud", mode: "cloud", health: 1, capacity: 0.1, privacy: 0.5, estimatedLatencyMs: 100, estimatedCostUsd: 0.01 }
    ]
  };
  const result = decide(input);
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.confidence > 0, true);
});

test("prefer-local is a soft preference, not a hard local-only rule", () => {
  const input = {
    workload: { type: "llm-inference", sensitivity: "high" },
    policy: { sensitiveDataMode: "prefer-local" },
    targets: [
      { id: "local", mode: "local", health: 0.8, capacity: 0.9, privacy: 1, estimatedLatencyMs: 700, estimatedCostUsd: 0.02 },
      { id: "private", mode: "private", health: 0.99, capacity: 0.1, privacy: 1, estimatedLatencyMs: 100, estimatedCostUsd: 0.01 }
    ]
  };
  const result = decide(input);
  assert.equal(result.targetId, "private");
  assert.equal(result.rejected.length, 0);
});

test("blocked modes are hard rejected", () => {
  const result = decide({
    workload: { type: "classification", sensitivity: "low" },
    policy: { blockedModes: ["cloud"] },
    targets: [
      { id: "cloud", mode: "cloud", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0 },
      { id: "local", mode: "local", health: 0.5, capacity: 0.5, privacy: 1, estimatedLatencyMs: 50, estimatedCostUsd: 0 }
    ]
  });
  assert.equal(result.targetId, "local");
  assert.deepEqual(result.rejected[0].reasons, ["mode_blocked"]);
});

test("unknown sensitivity values are rejected", () => {
  assert.throws(
    () => decide({
      workload: { type: "classification", sensitivity: "extreme" },
      targets: [{ id: "local", mode: "local" }]
    }),
    /workload.sensitivity must be one of/
  );
});

test("non-finite target metrics do not poison the decision with NaN", () => {
  const result = decide({
    workload: { type: "classification", sensitivity: "low" },
    targets: [
      { id: "broken", mode: "local", health: "not-a-number", capacity: "wat", privacy: "nan", estimatedLatencyMs: "bad", estimatedCostUsd: "bad" },
      { id: "healthy", mode: "private", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0 }
    ]
  });
  assert.equal(Number.isNaN(result.score), false);
  assert.equal(result.targetId, "healthy");
});

test("decisions expose a versioned trace for auditability", () => {
  const result = decide({
    workload: { type: "llm-inference", sensitivity: "low" },
    targets: [
      { id: "local", mode: "local", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 20, estimatedCostUsd: 0 },
      { id: "cloud", mode: "cloud", health: 1, capacity: 0.2, privacy: 0.5, estimatedLatencyMs: 40, estimatedCostUsd: 0.01 }
    ]
  });

  assert.equal(result.decisionVersion, "1.0");
  assert.equal(result.evaluated.length, 2);
  assert.equal(result.evaluated.find(item => item.targetId === result.targetId).eligible, true);
});

test("no-route responses still contain candidate trace", () => {
  const result = decide({
    workload: { type: "classification", sensitivity: "high" },
    policy: { sensitiveDataMode: "local-only" },
    targets: [
      { id: "cloud", mode: "cloud", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0.01 }
    ]
  });

  assert.equal(result.decisionVersion, "1.0");
  assert.equal(result.route, "none");
  assert.equal(result.evaluated[0].eligible, false);
});

test("strict latency rejects a target when latency telemetry is missing", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    constraints: { latencyBudgetMs: 500, strictLatency: true },
    targets: [{ id: "unknown-latency", mode: "private", health: 1, capacity: 0.1, privacy: 1, estimatedCostUsd: 0 }]
  });
  assert.equal(result.route, "none");
  assert.match(result.rejected[0].reasons[0], /latency_estimate_missing/);
});

test("strict cost rejects a target when cost telemetry is missing", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    constraints: { maxCostUsd: 0.05, strictCost: true },
    targets: [{ id: "unknown-cost", mode: "private", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 100 }]
  });
  assert.equal(result.route, "none");
  assert.match(result.rejected[0].reasons[0], /cost_estimate_missing/);
});

test("duplicate target ids fail the request instead of producing ambiguous output", () => {
  assert.throws(
    () => decide({
      workload: { type: "batch", sensitivity: "low" },
      targets: [
        { id: "same", mode: "local" },
        { id: "same", mode: "cloud" }
      ]
    }),
    /target ids must be unique/
  );
});

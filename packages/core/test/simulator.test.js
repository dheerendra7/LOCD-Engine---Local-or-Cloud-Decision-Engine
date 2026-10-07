import test from "node:test";
import assert from "node:assert/strict";
import { simulatePolicy } from "../src/simulator.js";

const targets = [
  {
    id: "local",
    mode: "local",
    available: true,
    health: 1,
    capacity: 0.1,
    privacy: 1,
    estimatedLatencyMs: 500,
    estimatedCostUsd: 0
  },
  {
    id: "cloud",
    mode: "cloud",
    available: true,
    health: 1,
    capacity: 0.1,
    privacy: 0.2,
    estimatedLatencyMs: 20,
    estimatedCostUsd: 0.01
  }
];

test("policy simulation compares canonical decisions without side effects", () => {
  const result = simulatePolicy({
    workload: { type: "simulation", sensitivity: "low" },
    constraints: { latencyBudgetMs: 1000 },
    targets,
    currentPolicy: { allowedModes: ["cloud"] },
    candidatePolicy: {
      allowedModes: ["local"],
      sensitiveDataMode: "balanced"
    }
  });

  assert.equal(result.version, "1.0");
  assert.equal(result.mutatedState, false);
  assert.equal(result.executedProvider, false);
  assert.equal(result.current.targetId, "cloud");
  assert.equal(result.candidate.targetId, "local");
  assert.equal(result.impact.routeChanged, true);
  assert.equal(result.impact.targetChanged, true);
  assert.equal(result.recommendation, "review_change");
});

test("unchanged policy returns no-routing-change", () => {
  const result = simulatePolicy({
    workload: { type: "classification", sensitivity: "low" },
    targets: [targets[0]],
    currentPolicy: { sensitiveDataMode: "balanced" },
    candidatePolicy: { sensitiveDataMode: "balanced" }
  });

  assert.equal(result.current.targetId, "local");
  assert.equal(result.candidate.targetId, "local");
  assert.equal(result.impact.targetChanged, false);
  assert.equal(result.recommendation, "no_routing_change");
});

test("simulation validates target input and is deterministic", () => {
  assert.throws(
    () => simulatePolicy({
      workload: { type: "x", sensitivity: "low" },
      targets: []
    }),
    /targets must be a non-empty array/
  );

  const first = simulatePolicy({
    workload: { type: "x", sensitivity: "low" },
    targets,
    currentPolicy: { sensitiveDataMode: "balanced" },
    candidatePolicy: { sensitiveDataMode: "balanced" }
  });
  const second = simulatePolicy({
    workload: { type: "x", sensitivity: "low" },
    targets,
    currentPolicy: { sensitiveDataMode: "balanced" },
    candidatePolicy: { sensitiveDataMode: "balanced" }
  });

  assert.deepEqual(first, second);
});

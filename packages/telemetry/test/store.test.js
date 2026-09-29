import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionStore, normalizeDecisionEvent } from "../src/index.js";

test("decision events normalize only routing metadata", () => {
  const event = normalizeDecisionEvent({
    id: "evt-1",
    timestamp: "2026-09-30T00:00:00Z",
    decisionVersion: "1.0",
    workloadType: "llm-inference",
    route: "local",
    targetId: "gpu-1",
    confidence: "0.9",
    estimatedLatencyMs: "120",
    estimatedCostUsd: "0.001",
    prompt: "this must never be stored"
  });

  assert.deepEqual(event, {
    id: "evt-1",
    timestamp: "2026-09-30T00:00:00.000Z",
    decisionVersion: "1.0",
    workloadType: "llm-inference",
    route: "local",
    targetId: "gpu-1",
    confidence: 0.9,
    estimatedLatencyMs: 120,
    estimatedCostUsd: 0.001,
    outcome: "unknown"
  });
  assert.equal("prompt" in event, false);
});

test("store enforces a bounded history", () => {
  const store = createDecisionStore({ maxEntries: 2 });
  store.record({ id: "1", route: "local" });
  store.record({ id: "2", route: "cloud" });
  store.record({ id: "3", route: "none" });

  assert.deepEqual(store.list({ limit: 10 }).map(item => item.id), ["3", "2"]);
});

test("summary aggregates route counts and estimates", () => {
  const store = createDecisionStore();
  store.record({ id: "1", route: "local", estimatedLatencyMs: 100, estimatedCostUsd: 0, confidence: 1 });
  store.record({ id: "2", route: "cloud", estimatedLatencyMs: 300, estimatedCostUsd: 0.02, confidence: 0.5 });
  store.record({ id: "3", route: "cloud", estimatedLatencyMs: 200, estimatedCostUsd: 0.01, confidence: 0.7 });

  assert.deepEqual(store.summary(), {
    totalDecisions: 3,
    routes: { local: 1, cloud: 2 },
    estimatedCostUsd: 0.03,
    averageEstimatedLatencyMs: 200,
    averageConfidence: 0.733333
  });
});

test("invalid route and capacity configuration fail clearly", () => {
  assert.throws(() => normalizeDecisionEvent({ route: "mars" }), /route is invalid/);
  assert.throws(() => createDecisionStore({ maxEntries: 0 }), /positive integer/);
});

test("outcome feedback updates a decision", () => {
  const store = createDecisionStore();
  const event = store.record({
    id: "decision-1",
    route: "local",
    workloadType: "llm-inference",
    estimatedLatencyMs: 400,
    estimatedCostUsd: 0.02
  });

  const updated = store.recordOutcome(event.id, {
    outcome: "success",
    actualLatencyMs: 350,
    actualCostUsd: 0.03,
    timestamp: "2026-09-30T00:01:00Z"
  });

  assert.equal(updated.outcome, "success");
  assert.equal(updated.actualLatencyMs, 350);
  assert.equal(updated.actualCostUsd, 0.03);
  assert.equal(updated.errorClass, null);
  assert.equal(updated.outcomeTimestamp, "2026-09-30T00:01:00.000Z");
});

test("missing decision IDs cannot be updated", () => {
  const store = createDecisionStore();
  assert.throws(
    () => store.recordOutcome("missing", { outcome: "failure" }),
    /decision_not_found/
  );
});

test("summary exposes outcome rate and calibration errors", () => {
  const store = createDecisionStore();
  store.record({
    id: "1",
    route: "local",
    estimatedLatencyMs: 400,
    estimatedCostUsd: 0.02,
    outcome: "pending"
  });
  store.record({
    id: "2",
    route: "cloud",
    estimatedLatencyMs: 200,
    estimatedCostUsd: 0.01,
    outcome: "success",
    actualLatencyMs: 260,
    actualCostUsd: 0.015
  });
  store.record({
    id: "3",
    route: "cloud",
    estimatedLatencyMs: 300,
    estimatedCostUsd: 0.02,
    outcome: "failure",
    actualLatencyMs: 500,
    actualCostUsd: 0.03
  });

  const summary = store.summary();
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.meanAbsoluteLatencyErrorMs, 130);
  assert.equal(summary.meanAbsoluteCostErrorUsd, 0.0075);
});

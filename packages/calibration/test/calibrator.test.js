import test from "node:test";
import assert from "node:assert/strict";
import { createCalibrator } from "../src/index.js";

test("calibrator waits for minimum samples before changing target estimates", () => {
  const calibrator = createCalibrator({ minSamples: 3, alpha: 0.5 });

  for (let i = 0; i < 2; i += 1) {
    calibrator.observe({
      targetId: "gpu",
      workloadType: "llm",
      estimatedLatencyMs: 100,
      actualLatencyMs: 200,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.02,
      outcome: "success"
    });
  }

  const before = calibrator.apply([{
    id: "gpu",
    estimatedLatencyMs: 100,
    estimatedCostUsd: 0.01
  }], "llm");

  assert.equal(before[0].estimatedLatencyMs, 100);
  assert.equal(before[0].estimatedCostUsd, 0.01);

  calibrator.observe({
    targetId: "gpu",
    workloadType: "llm",
    estimatedLatencyMs: 100,
    actualLatencyMs: 200,
    estimatedCostUsd: 0.01,
    actualCostUsd: 0.02,
    outcome: "success"
  });

  const after = calibrator.apply([{
    id: "gpu",
    estimatedLatencyMs: 100,
    estimatedCostUsd: 0.01
  }], "llm");

  assert.equal(after[0].estimatedLatencyMs, 200);
  assert.equal(after[0].estimatedCostUsd, 0.02);
});

test("calibration uses per-target and per-workload buckets", () => {
  const calibrator = createCalibrator({ minSamples: 1, alpha: 1 });

  calibrator.observe({
    targetId: "a",
    workloadType: "vision",
    estimatedLatencyMs: 100,
    actualLatencyMs: 150,
    outcome: "success"
  });

  calibrator.observe({
    targetId: "a",
    workloadType: "text",
    estimatedLatencyMs: 100,
    actualLatencyMs: 80,
    outcome: "success"
  });

  assert.equal(
    calibrator.apply([{ id: "a", estimatedLatencyMs: 100 }], "vision")[0].estimatedLatencyMs,
    150
  );
  assert.equal(
    calibrator.apply([{ id: "a", estimatedLatencyMs: 100 }], "text")[0].estimatedLatencyMs,
    80
  );
});

test("calibration factors are bounded", () => {
  const calibrator = createCalibrator({
    minSamples: 1,
    alpha: 1,
    minFactor: 0.5,
    maxFactor: 2
  });

  calibrator.observe({
    targetId: "bounded",
    workloadType: "batch",
    estimatedLatencyMs: 100,
    actualLatencyMs: 1000,
    outcome: "failure"
  });

  const target = calibrator.apply([{ id: "bounded", estimatedLatencyMs: 100 }], "batch")[0];
  assert.equal(target.estimatedLatencyMs, 200);
});

test("zero-cost estimates are not divided to create fake cost factors", () => {
  const calibrator = createCalibrator({ minSamples: 1 });

  calibrator.observe({
    targetId: "local",
    workloadType: "batch",
    estimatedLatencyMs: 50,
    actualLatencyMs: 60,
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    outcome: "success"
  });

  const result = calibrator.get("local", "batch");
  assert.equal(result.samples, 1);
  assert.equal(result.costFactor, null);
});

test("hydrate reconstructs calibration from completed telemetry events", () => {
  const calibrator = createCalibrator({ minSamples: 1, alpha: 1 });

  calibrator.hydrate([
    {
      targetId: "cloud",
      workloadType: "classification",
      estimatedLatencyMs: 100,
      actualLatencyMs: 125,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.0125,
      outcome: "success"
    },
    {
      targetId: "cloud",
      workloadType: "classification",
      estimatedLatencyMs: 100,
      actualLatencyMs: 150,
      estimatedCostUsd: 0.01,
      actualCostUsd: 0.015,
      outcome: "success"
    }
  ]);

  const state = calibrator.get("cloud", "classification");
  assert.equal(state.samples, 2);
  assert.equal(state.latencyFactor, 1.5);
  assert.equal(state.costFactor, 1.5);
});

test("invalid calibration configuration fails clearly", () => {
  assert.throws(
    () => createCalibrator({ alpha: 0 }),
    /alpha must be > 0/
  );
  assert.throws(
    () => createCalibrator({ minSamples: 0 }),
    /minSamples must be a positive integer/
  );
});

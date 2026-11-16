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

test("hydrate replays reverse-ordered telemetry chronologically by outcome time", () => {
  const older = {
    targetId: "cloud",
    workloadType: "classification",
    estimatedLatencyMs: 100,
    actualLatencyMs: 125,
    estimatedCostUsd: 0.01,
    actualCostUsd: 0.0125,
    outcome: "success",
    timestamp: "2026-11-16T10:00:00.000Z",
    outcomeTimestamp: "2026-11-16T10:05:00.000Z"
  };
  const newer = {
    ...older,
    actualLatencyMs: 150,
    actualCostUsd: 0.015,
    timestamp: "2026-11-16T10:01:00.000Z",
    outcomeTimestamp: "2026-11-16T10:10:00.000Z"
  };
  const latestFirst = [newer, older];
  const originalOrder = latestFirst.map(event => event.outcomeTimestamp);

  const recovered = createCalibrator({ minSamples: 1, alpha: 0.5 });
  recovered.hydrate(latestFirst);

  const continuous = createCalibrator({ minSamples: 1, alpha: 0.5 });
  continuous.observe({
    targetId: older.targetId,
    workloadType: older.workloadType,
    estimatedLatencyMs: older.estimatedLatencyMs,
    actualLatencyMs: older.actualLatencyMs,
    estimatedCostUsd: older.estimatedCostUsd,
    actualCostUsd: older.actualCostUsd,
    outcome: older.outcome
  });
  continuous.observe({
    targetId: newer.targetId,
    workloadType: newer.workloadType,
    estimatedLatencyMs: newer.estimatedLatencyMs,
    actualLatencyMs: newer.actualLatencyMs,
    estimatedCostUsd: newer.estimatedCostUsd,
    actualCostUsd: newer.actualCostUsd,
    outcome: newer.outcome
  });

  assert.deepEqual(recovered.snapshot(), continuous.snapshot());
  assert.equal(recovered.get("cloud", "classification").latencyFactor, 1.375);
  assert.equal(recovered.get("cloud", "classification").costFactor, 1.375);
  assert.deepEqual(latestFirst.map(event => event.outcomeTimestamp), originalOrder);
});

test("hydrate uses the decision timestamp for legacy events without outcome timestamps", () => {
  const older = {
    targetId: "cloud",
    workloadType: "batch",
    estimatedLatencyMs: 100,
    actualLatencyMs: 120,
    outcome: "success",
    timestamp: "2026-11-16T10:00:00.000Z"
  };
  const newer = {
    ...older,
    actualLatencyMs: 160,
    timestamp: "2026-11-16T10:10:00.000Z"
  };
  const recovered = createCalibrator({ minSamples: 1, alpha: 0.5 });
  recovered.hydrate([newer, older]);

  assert.equal(recovered.get("cloud", "batch").latencyFactor, 1.4);
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

test("utilization-aware calibration keeps separate factors for low and saturated load", () => {
  const calibrator = createCalibrator({ minSamples: 1, alpha: 1 });

  calibrator.observe({
    targetId: "gpu",
    workloadType: "llm",
    utilization: 0.10,
    estimatedLatencyMs: 100,
    actualLatencyMs: 120,
    outcome: "success"
  });

  calibrator.observe({
    targetId: "gpu",
    workloadType: "llm",
    utilization: 0.95,
    estimatedLatencyMs: 100,
    actualLatencyMs: 220,
    outcome: "success"
  });

  const low = calibrator.apply([{
    id: "gpu",
    capacity: 0.10,
    estimatedLatencyMs: 100
  }], "llm")[0];

  const saturated = calibrator.apply([{
    id: "gpu",
    capacity: 0.95,
    estimatedLatencyMs: 100
  }], "llm")[0];

  assert.equal(low.estimatedLatencyMs, 120);
  assert.equal(saturated.estimatedLatencyMs, 220);
});

test("calibration falls back to unknown-utilization history when no band exists", () => {
  const calibrator = createCalibrator({ minSamples: 1, alpha: 1 });

  calibrator.observe({
    targetId: "gpu",
    workloadType: "llm",
    estimatedLatencyMs: 100,
    actualLatencyMs: 150,
    outcome: "success"
  });

  const adjusted = calibrator.apply([{
    id: "gpu",
    capacity: 0.70,
    estimatedLatencyMs: 100
  }], "llm")[0];

  assert.equal(adjusted.estimatedLatencyMs, 150);
});

test("custom utilization bands are accepted and exposed in config", () => {
  const calibrator = createCalibrator({
    utilizationBands: {
      low: 0.20,
      moderate: 0.50,
      high: 0.80
    }
  });

  assert.deepEqual(calibrator.config.utilizationBands, {
    low: 0.20,
    moderate: 0.50,
    high: 0.80
  });

  assert.throws(
    () => createCalibrator({
      utilizationBands: { low: 0.5, moderate: 0.4, high: 0.8 }
    }),
    /utilizationBands must be increasing/
  );
});

test("null utilization maps to the unknown calibration band", () => {
  const calibrator = createCalibrator({ minSamples: 1 });
  calibrator.observe({
    targetId: "gpu",
    workloadType: "llm",
    utilization: null,
    estimatedLatencyMs: 100,
    actualLatencyMs: 150,
    outcome: "success"
  });

  assert.equal(calibrator.get("gpu", "llm", null).utilizationBand, "unknown");
  assert.equal(calibrator.get("gpu", "llm", " ").utilizationBand, "unknown");

  calibrator.observe({
    targetId: "gpu-blank",
    workloadType: "llm",
    utilization: " ",
    estimatedLatencyMs: 100,
    actualLatencyMs: 150,
    outcome: "success"
  });
  assert.equal(calibrator.get("gpu-blank", "llm", " ").utilizationBand, "unknown");
});

test("calibration factors are isolated by tenant", () => {
  const calibrator = createCalibrator({ minSamples: 1, alpha: 1 });

  calibrator.observe({
    tenantId: "acme",
    targetId: "shared-gpu",
    workloadType: "llm",
    estimatedLatencyMs: 100,
    actualLatencyMs: 200,
    outcome: "success"
  });

  calibrator.observe({
    tenantId: "beta",
    targetId: "shared-gpu",
    workloadType: "llm",
    estimatedLatencyMs: 100,
    actualLatencyMs: 120,
    outcome: "success"
  });

  assert.equal(
    calibrator.apply(
      [{ id: "shared-gpu", estimatedLatencyMs: 100 }],
      "llm",
      "acme"
    )[0].estimatedLatencyMs,
    200
  );

  assert.equal(
    calibrator.apply(
      [{ id: "shared-gpu", estimatedLatencyMs: 100 }],
      "llm",
      "beta"
    )[0].estimatedLatencyMs,
    120
  );

  assert.equal(calibrator.snapshot("acme")[0].tenantId, "acme");
  assert.equal(calibrator.snapshot("beta")[0].tenantId, "beta");
});

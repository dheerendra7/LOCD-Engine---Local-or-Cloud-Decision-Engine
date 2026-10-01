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
    outcome: "pending",
    actualLatencyMs: null,
    actualCostUsd: null,
    errorClass: null,
    outcomeTimestamp: null
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
    outcomes: { pending: 3, success: 0, failure: 0 },
    estimatedCostUsd: 0.03,
    averageEstimatedLatencyMs: 200,
    averageConfidence: 0.733333,
    successRate: null,
    meanAbsoluteLatencyErrorMs: null,
    meanAbsoluteCostErrorUsd: null
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

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileDecisionStore } from "../src/index.js";

test("in-memory store can restore initial events with a bounded cap", () => {
  const store = createDecisionStore({
    maxEntries: 2,
    initialEvents: [
      { id: "1", route: "local" },
      { id: "2", route: "cloud" },
      { id: "3", route: "private" }
    ]
  });

  assert.deepEqual(store.list({ limit: 10 }).map(item => item.id), ["3", "2"]);
});

test("file-backed store restores history across instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-telemetry-"));
  const file = path.join(dir, "events.json");

  try {
    const first = createFileDecisionStore({ filePath: file, maxEntries: 10 });
    first.record({
      id: "persisted-1",
      route: "local",
      workloadType: "classification",
      estimatedLatencyMs: 100,
      estimatedCostUsd: 0
    });

    const second = createFileDecisionStore({ filePath: file, maxEntries: 10 });
    assert.deepEqual(second.list({ limit: 10 }).map(item => item.id), ["persisted-1"]);
    assert.equal(second.summary().totalDecisions, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file-backed store persists outcomes and calibration metadata", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-telemetry-outcome-"));
  const file = path.join(dir, "events.json");

  try {
    const store = createFileDecisionStore({ filePath: file, maxEntries: 10 });
    const event = store.record({
      id: "decision-1",
      route: "cloud",
      estimatedLatencyMs: 200,
      estimatedCostUsd: 0.01,
      prompt: "do not persist"
    });

    store.recordOutcome(event.id, {
      outcome: "success",
      actualLatencyMs: 250,
      actualCostUsd: 0.012
    });

    const restored = createFileDecisionStore({ filePath: file, maxEntries: 10 });
    const restoredEvent = restored.list({ limit: 1 })[0];

    assert.equal(restoredEvent.outcome, "success");
    assert.equal(restoredEvent.actualLatencyMs, 250);
    assert.equal("prompt" in restoredEvent, false);
    assert.equal(restored.summary().meanAbsoluteLatencyErrorMs, 50);

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal("prompt" in raw[0], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file-backed store treats a missing file as empty state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-telemetry-missing-"));
  const file = path.join(dir, "events.json");

  try {
    const store = createFileDecisionStore({ filePath: file });
    assert.equal(store.summary().totalDecisions, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid telemetry files fail without silently accepting malformed state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-telemetry-invalid-"));
  const file = path.join(dir, "events.json");

  try {
    await writeFile(file, JSON.stringify({ invalid: true }), "utf8");
    assert.throws(
      () => createFileDecisionStore({ filePath: file }),
      /telemetry file must contain an array/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

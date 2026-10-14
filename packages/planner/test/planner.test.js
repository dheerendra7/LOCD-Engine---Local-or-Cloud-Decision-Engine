import test from "node:test";
import assert from "node:assert/strict";
import { planHybridExecution } from "../src/index.js";

const targets = [
  {
    id: "local-pre",
    mode: "local",
    available: true,
    regions: ["local"],
    estimatedLatencyMs: 40,
    estimatedCostUsd: 0
  },
  {
    id: "private-infer",
    mode: "private",
    available: true,
    regions: ["ap-south-1"],
    estimatedLatencyMs: 220,
    estimatedCostUsd: 0.01
  },
  {
    id: "cloud",
    mode: "cloud",
    available: true,
    regions: ["us-east-1"],
    estimatedLatencyMs: 120,
    estimatedCostUsd: 0.02
  }
];

test("valid hybrid plan aggregates sequential latency and cost", () => {
  const result = planHybridExecution({
    workload: { type: "llm-inference", sensitivity: "medium" },
    steps: [
      { id: "preprocess", purpose: "redact", targetId: "local-pre" },
      { id: "infer", purpose: "inference", targetId: "private-infer" },
      { id: "postprocess", purpose: "postprocess", targetId: "local-pre" }
    ],
    targets
  });

  assert.equal(result.valid, true);
  assert.equal(result.route, "hybrid");
  assert.equal(result.steps.length, 3);
  assert.equal(result.estimated.latencyMs, 300);
  assert.equal(result.estimated.costUsd, 0.01);
});

test("local-only policy rejects a cloud sensitive step", () => {
  const result = planHybridExecution({
    workload: { type: "llm-inference", sensitivity: "high" },
    policy: { sensitiveDataMode: "local-only" },
    steps: [
      { id: "preprocess", targetId: "local-pre" },
      { id: "infer", targetId: "cloud" }
    ],
    targets
  });

  assert.equal(result.valid, false);
  assert.match(result.rejected.flatMap(item => item.reasons).join(","), /sensitive_stage_requires_local_execution/);
});

test("private-only policy permits local plus private execution", () => {
  const result = planHybridExecution({
    workload: { type: "llm-inference", sensitivity: "high" },
    policy: { sensitiveDataMode: "private-only" },
    steps: [
      { id: "preprocess", targetId: "local-pre" },
      { id: "infer", targetId: "private-infer" }
    ],
    targets
  });

  assert.equal(result.valid, true);
});

test("strict budgets fail closed when telemetry is missing", () => {
  const result = planHybridExecution({
    workload: { type: "batch", sensitivity: "low" },
    constraints: {
      maxLatencyMs: 500,
      maxCostUsd: 0.05,
      strictLatency: true,
      strictCost: true
    },
    steps: [
      { id: "a", targetId: "local-pre" },
      { id: "b", targetId: "unknown" }
    ],
    targets: [
      { ...targets[0] },
      { id: "unknown", mode: "private", available: true }
    ]
  });

  assert.equal(result.valid, false);
  assert.equal(result.rejected.some(item => item.reasons.includes("latency_estimate_missing")), true);
  assert.equal(result.rejected.some(item => item.reasons.includes("cost_estimate_missing")), true);
});

test("explicit null telemetry remains unknown and does not become a zero estimate", () => {
  const result = planHybridExecution({
    workload: { type: "batch", sensitivity: "low" },
    constraints: {
      maxLatencyMs: null,
      maxCostUsd: null,
      strictLatency: false,
      strictCost: false
    },
    steps: [
      { id: "a", targetId: "unknown-a" },
      { id: "b", targetId: "unknown-b" }
    ],
    targets: [
      { id: "unknown-a", mode: "local", available: true, estimatedLatencyMs: null, estimatedCostUsd: null },
      { id: "unknown-b", mode: "private", available: true, estimatedLatencyMs: null, estimatedCostUsd: null }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.steps[0].estimatedLatencyMs, null);
  assert.equal(result.steps[0].estimatedCostUsd, null);
  assert.equal(result.estimated.latencyMs, null);
  assert.equal(result.estimated.costUsd, null);
});

test("strict hybrid budgets fail closed when telemetry is explicitly null", () => {
  const result = planHybridExecution({
    workload: { type: "batch", sensitivity: "low" },
    constraints: {
      maxLatencyMs: 500,
      maxCostUsd: 0.05,
      strictLatency: true,
      strictCost: true
    },
    steps: [
      { id: "a", targetId: "unknown-a" },
      { id: "b", targetId: "unknown-b" }
    ],
    targets: [
      { id: "unknown-a", mode: "local", available: true, estimatedLatencyMs: null, estimatedCostUsd: null },
      { id: "unknown-b", mode: "private", available: true, estimatedLatencyMs: null, estimatedCostUsd: null }
    ]
  });

  assert.equal(result.valid, false);
  assert.equal(result.estimated.latencyMs, null);
  assert.equal(result.estimated.costUsd, null);
  assert.equal(result.rejected.some(item => item.reasons.includes("latency_estimate_missing")), true);
  assert.equal(result.rejected.some(item => item.reasons.includes("cost_estimate_missing")), true);
});

test("unavailable target rejects the step", () => {
  const result = planHybridExecution({
    workload: { type: "batch", sensitivity: "low" },
    steps: [
      { id: "a", targetId: "local-pre" },
      { id: "b", targetId: "bad" }
    ],
    targets: [
      { ...targets[0] },
      { id: "bad", mode: "private", available: false, estimatedLatencyMs: 10, estimatedCostUsd: 0 }
    ]
  });

  assert.equal(result.valid, false);
  assert.match(result.rejected.flatMap(item => item.reasons).join(","), /target_unavailable/);
});

test("invalid per-step sensitivity is rejected instead of bypassing privacy policy", () => {
  const base = {
    workload: { type: "llm-inference", sensitivity: "low" },
    policy: { sensitiveDataMode: "local-only" },
    steps: [
      { id: "preprocess", targetId: "local-pre" },
      { id: "infer", targetId: "cloud", dataSensitivity: "ultra-sensitive" }
    ],
    targets
  };

  assert.throws(
    () => planHybridExecution(base),
    /steps\[1\]\.dataSensitivity must be one of: low, medium, high/
  );
});

test("duplicate target identifiers are rejected instead of silently selecting the last entry", () => {
  const duplicateTargets = [
    { id: "shared", mode: "local", available: true, estimatedLatencyMs: 10, estimatedCostUsd: 0 },
    { id: "shared", mode: "cloud", available: true, estimatedLatencyMs: 10, estimatedCostUsd: 0 }
  ];
  assert.throws(
    () => planHybridExecution({
      workload: { type: "batch", sensitivity: "low" },
      steps: [{ id: "a", targetId: "shared" }, { id: "b", targetId: "local-pre" }],
      targets: [...duplicateTargets, targets[0]]
    }),
    /target ids must be unique/
  );
});

test("duplicate steps are rejected", () => {
  const result = planHybridExecution({
    workload: { type: "batch" },
    steps: [
      { id: "same", targetId: "local-pre" },
      { id: "same", targetId: "private-infer" }
    ],
    targets
  });

  assert.equal(result.valid, false);
  assert.match(result.rejected.flatMap(item => item.reasons).join(","), /duplicate_step_id/);
});

test("a hybrid plan cannot use only one target", () => {
  const result = planHybridExecution({
    workload: { type: "batch" },
    steps: [
      { id: "a", targetId: "local-pre" },
      { id: "b", targetId: "local-pre" }
    ],
    targets
  });

  assert.equal(result.valid, false);
  assert.match(result.rejected.flatMap(item => item.reasons).join(","), /hybrid_plan_requires_multiple_targets/);
});


test("whitespace estimates remain unknown in hybrid planning", () => {
  const result = planHybridExecution({
    workload: { type: "batch", sensitivity: "low" },
    steps: [
      { id: "a", targetId: "blank-a" },
      { id: "b", targetId: "blank-b" }
    ],
    targets: [
      { id: "blank-a", mode: "local", available: true, estimatedLatencyMs: " ", estimatedCostUsd: " " },
      { id: "blank-b", mode: "private", available: true, estimatedLatencyMs: " ", estimatedCostUsd: " " }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.steps[0].estimatedLatencyMs, null);
  assert.equal(result.steps[0].estimatedCostUsd, null);
  assert.equal(result.estimated.latencyMs, null);
  assert.equal(result.estimated.costUsd, null);
});


test("blank hybrid budget constraints are rejected instead of disabled", () => {
  const basePlan = {
    workload: { type: "batch", sensitivity: "low" },
    steps: [
      { id: "a", targetId: "local-pre" },
      { id: "b", targetId: "private-infer" }
    ],
    targets
  };

  assert.throws(
    () => planHybridExecution({ ...basePlan, constraints: { maxCostUsd: " " } }),
    /constraints.maxCostUsd must be >= 0/
  );
  assert.throws(
    () => planHybridExecution({ ...basePlan, constraints: { maxLatencyMs: " " } }),
    /constraints.maxLatencyMs must be >= 0/
  );
});


test("negative stage estimates remain unknown rather than becoming zero", () => {
  const result = planHybridExecution({
    workload: { type: "batch", sensitivity: "low" },
    constraints: {
      strictLatency: true,
      strictCost: true,
      maxLatencyMs: 1000,
      maxCostUsd: 1
    },
    steps: [
      { id: "bad", targetId: "negative" },
      { id: "good", targetId: "known" }
    ],
    targets: [
      { id: "negative", mode: "local", available: true, estimatedLatencyMs: -1, estimatedCostUsd: -1 },
      { id: "known", mode: "private", available: true, estimatedLatencyMs: 100, estimatedCostUsd: 0.1 }
    ]
  });

  assert.equal(result.valid, false);
  assert.equal(result.steps[0].estimatedLatencyMs, null);
  assert.equal(result.steps[0].estimatedCostUsd, null);
  assert.equal(result.rejected.some(item => item.stepId === "bad" && item.reasons.includes("latency_estimate_missing")), true);
  assert.equal(result.rejected.some(item => item.stepId === "bad" && item.reasons.includes("cost_estimate_missing")), true);
});

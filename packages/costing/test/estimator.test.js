import test from "node:test";
import assert from "node:assert/strict";
import { applyCostEstimates, estimateWorkloadCost } from "../src/index.js";

test("explicit target cost has precedence over pricing", () => {
  assert.deepEqual(
    estimateWorkloadCost({
      workload: { inputTokens: 1000, outputTokens: 1000 },
      target: {
        estimatedCostUsd: 0.123,
        pricing: {
          unit: "per-1k-tokens",
          inputUsdPer1kTokens: 1,
          outputUsdPer1kTokens: 1
        }
      }
    }),
    {
      costUsd: 0.123,
      source: "explicit",
      reason: "target_estimated_cost"
    }
  );
});

test("token pricing estimates input and output cost", () => {
  const result = estimateWorkloadCost({
    workload: { inputTokens: 2000, outputTokens: 500 },
    target: {
      pricing: {
        unit: "per-1k-tokens",
        inputUsdPer1kTokens: 0.003,
        outputUsdPer1kTokens: 0.012
      }
    }
  });

  assert.equal(result.costUsd, 0.012);
  assert.equal(result.source, "pricing");
});

test("per-request pricing multiplies by request count", () => {
  const result = estimateWorkloadCost({
    workload: { requests: 3 },
    target: {
      pricing: {
        unit: "per-request",
        requestUsd: 0.02
      }
    }
  });

  assert.equal(result.costUsd, 0.06);
});

test("flat pricing works without token metadata", () => {
  const result = estimateWorkloadCost({
    target: {
      pricing: {
        unit: "flat",
        flatUsd: 0.05
      }
    }
  });

  assert.equal(result.costUsd, 0.05);
});

test("missing pricing returns unknown rather than inventing a number", () => {
  const result = estimateWorkloadCost({
    workload: { inputTokens: 1000 },
    target: {}
  });

  assert.equal(result.costUsd, null);
  assert.equal(result.source, "unknown");
});

test("cost estimator rejects invalid pricing and usage", () => {
  assert.throws(
    () => estimateWorkloadCost({
      target: { pricing: { unit: "unknown" } }
    }),
    /unit must be flat/
  );

  assert.throws(
    () => estimateWorkloadCost({
      workload: { inputTokens: -1 },
      target: { pricing: { unit: "flat", flatUsd: 0.01 } }
    }),
    /inputTokens must be a non-negative integer/
  );
});

test("applyCostEstimates fills only missing explicit costs", () => {
  const targets = applyCostEstimates(
    [
      {
        id: "priced",
        estimatedCostUsd: null,
        pricing: {
          unit: "per-1k-tokens",
          inputUsdPer1kTokens: 0.002,
          outputUsdPer1kTokens: 0.004
        }
      },
      {
        id: "explicit",
        estimatedCostUsd: 0.1,
        pricing: {
          unit: "flat",
          flatUsd: 1
        }
      }
    ],
    {
      inputTokens: 1000,
      outputTokens: 500
    }
  );

  assert.equal(targets[0].estimatedCostUsd, 0.004);
  assert.equal(targets[1].estimatedCostUsd, 0.1);
});

test("explicit zero requests produce zero per-request cost", () => {
  const result = estimateWorkloadCost({
    workload: { requests: 0 },
    target: {
      pricing: {
        unit: "per-request",
        requestUsd: 0.02
      }
    }
  });

  assert.equal(result.costUsd, 0);
});

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

test("named policy profile can drive a decision", () => {
  const result = decide({
    workload: { type: "llm-inference", sensitivity: "high" },
    policy: { profile: "strictLocalSensitive" },
    targets: [
      { id: "local", mode: "local", health: 0.9, capacity: 0.2, privacy: 1, estimatedLatencyMs: 200, estimatedCostUsd: 0 },
      { id: "cloud", mode: "cloud", health: 1, capacity: 0.1, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0 }
    ]
  });
  assert.equal(result.route, "local");
  assert.deepEqual(result.rejected[0].reasons, [
    "mode_not_allowed",
    "sensitive_workload_requires_local_execution"
  ]);
});

test("memory capacity is a hard workload-fit constraint", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      requiredMemoryGb: 16
    },
    targets: [
      {
        id: "small-gpu",
        mode: "local",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        availableMemoryGb: 8,
        estimatedLatencyMs: 20,
        estimatedCostUsd: 0
      },
      {
        id: "large-gpu",
        mode: "private",
        health: 0.99,
        capacity: 0.2,
        privacy: 1,
        availableMemoryGb: 24,
        estimatedLatencyMs: 80,
        estimatedCostUsd: 0.01
      }
    ]
  });

  assert.equal(result.targetId, "large-gpu");
  assert.equal(result.rejected[0].reasons[0], "memory_capacity_exceeded");
});

test("missing memory telemetry rejects a resource-constrained workload", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      requiredMemoryGb: 8
    },
    targets: [
      {
        id: "unknown-memory",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 30,
        estimatedCostUsd: 0.01
      }
    ]
  });

  assert.equal(result.route, "none");
  assert.equal(result.rejected[0].reasons[0], "memory_capacity_unknown");
});

test("context capacity is enforced independently from memory", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      requiredContextTokens: 32000
    },
    targets: [
      {
        id: "short-context",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        maxContextTokens: 16000,
        estimatedLatencyMs: 20,
        estimatedCostUsd: 0.01
      },
      {
        id: "long-context",
        mode: "cloud",
        health: 0.99,
        capacity: 0.1,
        privacy: 1,
        maxContextTokens: 64000,
        estimatedLatencyMs: 40,
        estimatedCostUsd: 0.02
      }
    ]
  });

  assert.equal(result.targetId, "long-context");
  assert.equal(result.rejected[0].reasons[0], "context_capacity_exceeded");
});

test("negative workload resource requirements are rejected", () => {
  assert.throws(
    () => decide({
      workload: { type: "llm-inference", requiredMemoryGb: -1 },
      targets: [{ id: "local", mode: "local" }]
    }),
    /workload.requiredMemoryGb must be >= 0/
  );

  assert.throws(
    () => decide({
      workload: { type: "llm-inference", requiredContextTokens: -1 },
      targets: [{ id: "local", mode: "local" }]
    }),
    /workload.requiredContextTokens must be >= 0/
  );
});

test("invalid negative capacity telemetry cannot win", () => {
  const result = decide({
    workload: { type: "llm-inference", requiredMemoryGb: 4 },
    targets: [{
      id: "bad-capacity",
      mode: "local",
      health: 1,
      capacity: 0.1,
      privacy: 1,
      availableMemoryGb: -5,
      estimatedLatencyMs: 20,
      estimatedCostUsd: 0
    }]
  });
  assert.equal(result.route, "none");
  assert.deepEqual(result.rejected[0].reasons, ["invalid_memory_telemetry"]);
});

test("heartbeat freshness can be enforced as a hard policy", () => {
  const now = Date.now();

  const stale = decide({
    workload: { type: "batch", sensitivity: "low" },
    policy: { maxHeartbeatAgeMs: 1000 },
    targets: [{
      id: "stale",
      mode: "local",
      health: 1,
      capacity: 0.1,
      privacy: 1,
      lastHeartbeatAt: new Date(now - 5000).toISOString(),
      estimatedLatencyMs: 20,
      estimatedCostUsd: 0
    }]
  });
  assert.equal(stale.route, "none");
  assert.equal(stale.rejected[0].reasons[0], "target_heartbeat_stale");

  const fresh = decide({
    workload: { type: "batch", sensitivity: "low" },
    policy: { maxHeartbeatAgeMs: 1000 },
    targets: [{
      id: "fresh",
      mode: "local",
      health: 1,
      capacity: 0.1,
      privacy: 1,
      lastHeartbeatAt: new Date(now).toISOString(),
      estimatedLatencyMs: 20,
      estimatedCostUsd: 0
    }]
  });
  assert.equal(fresh.targetId, "fresh");
});

test("heartbeat freshness policy rejects unknown heartbeat state", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    policy: { maxHeartbeatAgeMs: 1000 },
    targets: [{
      id: "unknown-heartbeat",
      mode: "local",
      health: 1,
      capacity: 0.1,
      privacy: 1,
      estimatedLatencyMs: 20,
      estimatedCostUsd: 0
    }]
  });
  assert.equal(result.route, "none");
  assert.equal(result.rejected[0].reasons[0], "heartbeat_staleness_unknown");
});

test("negative heartbeat age policy is rejected", () => {
  assert.throws(
    () => decide({
      workload: { type: "batch" },
      policy: { maxHeartbeatAgeMs: -1 },
      targets: [{ id: "x", mode: "local" }]
    }),
    /policy.maxHeartbeatAgeMs must be >= 0/
  );
});


test("policy rules can apply workload-specific hard constraints", () => {
  const result = decide({
    workload: {
      type: "legal-llm",
      sensitivity: "high"
    },
    policy: {
      rules: [
        {
          id: "legal-local-only",
          priority: 100,
          when: { workloadType: "legal-llm", sensitivity: "high" },
          set: { sensitiveDataMode: "local-only", allowedModes: ["local"] }
        }
      ]
    },
    targets: [
      { id: "cloud", mode: "cloud", health: 1, privacy: 1, estimatedLatencyMs: 20, estimatedCostUsd: 0 },
      { id: "local", mode: "local", health: 1, privacy: 1, estimatedLatencyMs: 30, estimatedCostUsd: 0 }
    ]
  });

  assert.equal(result.targetId, "local");
  assert.deepEqual(result.policyRulesApplied, ["legal-local-only"]);
  assert.equal(result.reasons.includes("policy_rule_applied:legal-local-only"), true);
});

test("higher-priority rules win deterministic scalar conflicts", () => {
  const result = decide({
    workload: {
      type: "finance",
      sensitivity: "medium"
    },
    policy: {
      rules: [
        {
          id: "low-priority",
          priority: 10,
          when: { workloadType: "finance" },
          set: { allowedModes: ["local"] }
        },
        {
          id: "high-priority",
          priority: 100,
          when: { workloadType: "finance" },
          set: { allowedModes: ["private"] }
        }
      ]
    },
    targets: [
      { id: "local", mode: "local", health: 1, privacy: 1, estimatedLatencyMs: 20, estimatedCostUsd: 0 },
      { id: "private", mode: "private", health: 1, privacy: 0.9, estimatedLatencyMs: 40, estimatedCostUsd: 0 }
    ]
  });

  assert.equal(result.targetId, "private");
  assert.deepEqual(result.policyRulesApplied, ["low-priority", "high-priority"]);
});

test("later rule of the same priority wins by deterministic declaration order", () => {
  const result = decide({
    workload: {
      type: "finance",
      sensitivity: "low"
    },
    policy: {
      rules: [
        {
          id: "first",
          priority: 50,
          when: { workloadType: "finance" },
          set: { allowedModes: ["local"] }
        },
        {
          id: "second",
          priority: 50,
          when: { workloadType: "finance" },
          set: { allowedModes: ["cloud"] }
        }
      ]
    },
    targets: [
      { id: "local", mode: "local", health: 1, privacy: 1, estimatedLatencyMs: 10, estimatedCostUsd: 0 },
      { id: "cloud", mode: "cloud", health: 1, privacy: 0.8, estimatedLatencyMs: 20, estimatedCostUsd: 0 }
    ]
  });

  assert.equal(result.targetId, "cloud");
  assert.deepEqual(result.policyRulesApplied, ["first", "second"]);
});

test("invalid policy rule configuration fails early", () => {
  assert.throws(
    () => decide({
      workload: { type: "x" },
      policy: {
        rules: [{
          id: "bad-mode",
          when: { workloadType: "x" },
          set: { allowedModes: ["satellite"] }
        }]
      },
      targets: [{ id: "local", mode: "local" }]
    }),
    /policy rule allowedModes contains an invalid mode/
  );

  assert.throws(
    () => decide({
      workload: { type: "x" },
      policy: {
        rules: [{
          id: "bad-sensitivity-mode",
          set: { sensitiveDataMode: "top-secret" }
        }]
      },
      targets: [{ id: "local", mode: "local" }]
    }),
    /policy rule sensitiveDataMode is invalid/
  );
});

test("policy rules can match required capabilities", () => {
  const result = decide({
    workload: {
      type: "vision",
      sensitivity: "low",
      requiredCapabilities: ["vision"]
    },
    policy: {
      rules: [{
        id: "vision-private",
        priority: 20,
        when: { requiredCapability: "vision" },
        set: { allowedModes: ["private"] }
      }]
    },
    targets: [
      { id: "local", mode: "local", health: 1, privacy: 1, capabilities: ["vision", "text-generation"] },
      { id: "private", mode: "private", health: 1, privacy: 1, capabilities: ["vision", "text-generation"] }
    ]
  });

  assert.equal(result.targetId, "private");
  assert.deepEqual(result.policyRulesApplied, ["vision-private"]);
});


test("decision engine derives cost from target pricing when explicit cost is absent", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      inputTokens: 1000,
      outputTokens: 500
    },
    constraints: {
      strictCost: true,
      maxCostUsd: 0.02
    },
    targets: [{
      id: "priced-cloud",
      mode: "cloud",
      health: 1,
      capacity: 0.2,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      pricing: {
        unit: "per-1k-tokens",
        inputUsdPer1kTokens: 0.002,
        outputUsdPer1kTokens: 0.004
      }
    }]
  });

  assert.equal(result.targetId, "priced-cloud");
  assert.equal(result.estimated.costUsd, 0.004);
  assert.equal(result.evaluated[0].costEstimate.source, "pricing");
});

test("explicit estimated cost overrides target pricing", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      inputTokens: 1000,
      outputTokens: 1000
    },
    targets: [{
      id: "explicit",
      mode: "cloud",
      health: 1,
      capacity: 0.2,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      estimatedCostUsd: 0.03,
      pricing: {
        unit: "flat",
        flatUsd: 0
      }
    }]
  });

  assert.equal(result.estimated.costUsd, 0.03);
  assert.equal(result.evaluated[0].costEstimate.source, "explicit");
});

test("negative token usage is rejected before candidate evaluation", () => {
  assert.throws(
    () => decide({
      workload: {
        type: "llm-inference",
        inputTokens: -1
      },
      targets: [{ id: "x", mode: "local" }]
    }),
    /workload.inputTokens must be a non-negative integer/
  );
});

test("relative cost scoring prefers the cheaper eligible target when no budget is supplied", () => {
  const result = decide({
    workload: { type: "llm-inference", sensitivity: "low" },
    targets: [
      {
        id: "a-expensive",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.2
      },
      {
        id: "z-cheaper",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.05
      }
    ]
  });

  assert.equal(result.targetId, "z-cheaper");
  assert.equal(result.evaluated.find(item => item.targetId === "z-cheaper").factors.cost, 1);
  assert.equal(result.evaluated.find(item => item.targetId === "a-expensive").factors.cost, 0);
  assert.ok(result.evaluated.find(item => item.targetId === "z-cheaper").score >
    result.evaluated.find(item => item.targetId === "a-expensive").score);
});

test("relative cost scoring preserves budget-referenced factors when a budget is supplied", () => {
  const result = decide({
    workload: { type: "llm-inference", sensitivity: "low" },
    constraints: { maxCostUsd: 0.2 },
    targets: [
      {
        id: "cheap",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.05
      },
      {
        id: "expensive",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.15
      }
    ]
  });

  const evaluated = Object.fromEntries(result.evaluated.map(item => [item.targetId, item]));
  assert.equal(evaluated.cheap.factors.cost, 0.75);
  assert.equal(evaluated.expensive.factors.cost, 0.25);
  assert.equal(result.targetId, "cheap");
});

test("relative cost scoring retains fallback factors when only one eligible target has a known price", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    targets: [
      {
        id: "known",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.05
      },
      {
        id: "unknown",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100
      }
    ]
  });

  const evaluated = Object.fromEntries(result.evaluated.map(item => [item.targetId, item]));
  assert.equal(evaluated.known.factors.cost, 0.5);
  assert.equal(evaluated.unknown.costEstimate.usd, null);
  assert.equal(evaluated.unknown.factors.cost, 0);
});

test("relative cost scoring retains fallback factors when eligible targets have equal known prices", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    targets: [
      {
        id: "a",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.02
      },
      {
        id: "b",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.02
      }
    ]
  });

  const evaluated = Object.fromEntries(result.evaluated.map(item => [item.targetId, item]));
  assert.equal(evaluated.a.factors.cost, 0.5);
  assert.equal(evaluated.b.factors.cost, 0.5);
});

test("relative cost normalization uses only eligible targets and ignores unknown estimates", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    targets: [
      {
        id: "eligible-cheap",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.05
      },
      {
        id: "eligible-expensive",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0.15
      },
      {
        id: "unknown-price",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100
      },
      {
        id: "ineligible-cheapest",
        mode: "cloud",
        health: 1,
        capacity: 0.1,
        privacy: 1,
        estimatedLatencyMs: 100,
        estimatedCostUsd: 0,
        available: false
      }
    ]
  });

  const evaluated = Object.fromEntries(result.evaluated.map(item => [item.targetId, item]));
  assert.equal(evaluated["eligible-cheap"].factors.cost, 1);
  assert.equal(evaluated["eligible-expensive"].factors.cost, 0);
  assert.equal(evaluated["unknown-price"].costEstimate.usd, null);
  assert.equal(evaluated["ineligible-cheapest"].eligible, false);
  assert.equal(evaluated["ineligible-cheapest"].factors, null);
});

test("token-based pricing stays unknown when either token count is missing", () => {
  const pricing = {
    unit: "per-1k-tokens",
    inputUsdPer1kTokens: 0.003,
    outputUsdPer1kTokens: 0.012
  };
  const workloads = [
    { type: "llm-inference", sensitivity: "low" },
    { type: "llm-inference", sensitivity: "low", inputTokens: 1000 },
    { type: "llm-inference", sensitivity: "low", outputTokens: 500 }
  ];

  for (const workload of workloads) {
    const result = decide({
      workload,
      constraints: { strictCost: true, maxCostUsd: 0.05 },
      targets: [{
        id: "priced-cloud",
        mode: "cloud",
        health: 1,
        capacity: 0.2,
        privacy: 0.5,
        estimatedLatencyMs: 100,
        pricing
      }]
    });

    assert.equal(result.route, "none");
    assert.equal(result.rejected[0].reasons.includes("cost_estimate_missing"), true);
  }
});

test("explicitly zero token usage produces a valid zero token-based cost", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      inputTokens: 0,
      outputTokens: 0
    },
    targets: [{
      id: "zero-token-cloud",
      mode: "cloud",
      health: 1,
      capacity: 0.2,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      pricing: {
        unit: "per-1k-tokens",
        inputUsdPer1kTokens: 0.003,
        outputUsdPer1kTokens: 0.012
      }
    }]
  });

  assert.equal(result.estimated.costUsd, 0);
  assert.equal(result.evaluated[0].costEstimate.source, "pricing");
});

test("flat pricing does not require token usage", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    targets: [{
      id: "flat-cloud",
      mode: "cloud",
      health: 1,
      capacity: 0.2,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      pricing: { unit: "flat", flatUsd: 0.003 }
    }]
  });

  assert.equal(result.estimated.costUsd, 0.003);
  assert.equal(result.evaluated[0].costEstimate.source, "pricing");
});

test("per-request pricing does not require token usage", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low", requests: 3 },
    targets: [{
      id: "request-priced-cloud",
      mode: "cloud",
      health: 1,
      capacity: 0.2,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      pricing: { unit: "per-request", requestUsd: 0.002 }
    }]
  });

  assert.equal(result.estimated.costUsd, 0.006);
  assert.equal(result.evaluated[0].costEstimate.source, "pricing");
});

test("pricing can make a target ineligible under a strict budget", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      inputTokens: 1000,
      outputTokens: 1000
    },
    constraints: {
      strictCost: true,
      maxCostUsd: 0.001
    },
    targets: [{
      id: "expensive",
      mode: "cloud",
      health: 1,
      capacity: 0.1,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      pricing: {
        unit: "per-1k-tokens",
        inputUsdPer1kTokens: 0.002,
        outputUsdPer1kTokens: 0.002
      }
    }]
  });

  assert.equal(result.route, "none");
  assert.equal(result.rejected[0].reasons.includes("cost_budget_exceeded"), true);
});


test("blank token usage and target telemetry remain unknown rather than zero", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      inputTokens: " ",
      outputTokens: " "
    },
    policy: { sensitiveDataMode: "balanced" },
    targets: [{
      id: "blank-target",
      mode: "cloud",
      available: true,
      health: 1,
      capacity: " ",
      privacy: 0.5,
      estimatedLatencyMs: " ",
      estimatedCostUsd: null,
      pricing: {
        unit: "per-1k-tokens",
        currency: "USD",
        inputUsdPer1kTokens: 0.003,
        outputUsdPer1kTokens: 0.012
      }
    }]
  });

  assert.equal(result.route, "cloud");
  assert.equal(result.targetId, "blank-target");
  assert.equal(result.estimated.latencyMs, null);
  assert.equal(result.estimated.costUsd, null);
});


test("blank budget and freshness constraints are rejected instead of being disabled", () => {
  assert.throws(
    () => decide({
      workload: { type: "batch", sensitivity: "low" },
      constraints: { maxCostUsd: " ", strictCost: true },
      targets: [{ id: "local", mode: "local", estimatedCostUsd: 0 }]
    }),
    /constraints.maxCostUsd must be >= 0/
  );

  assert.throws(
    () => decide({
      workload: { type: "batch", sensitivity: "low" },
      policy: { maxHeartbeatAgeMs: " " },
      targets: [{ id: "local", mode: "local", estimatedCostUsd: 0 }]
    }),
    /policy.maxHeartbeatAgeMs must be >= 0/
  );
});


test("decision output uses validated pricing when explicit target cost is negative", () => {
  const result = decide({
    workload: {
      type: "llm-inference",
      sensitivity: "low",
      inputTokens: 1000,
      outputTokens: 500
    },
    targets: [{
      id: "repaired-cost",
      mode: "cloud",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 0.5,
      estimatedLatencyMs: 100,
      estimatedCostUsd: -1,
      pricing: { unit: "flat", flatUsd: 0.04 }
    }]
  });

  assert.equal(result.targetId, "repaired-cost");
  assert.equal(result.estimated.costUsd, 0.04);
  assert.equal(result.evaluated[0].costEstimate.usd, 0.04);
});


test("negative target latency cannot be returned as a valid latency estimate", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    constraints: { latencyBudgetMs: 500, strictLatency: true },
    targets: [{
      id: "negative-latency",
      mode: "cloud",
      available: true,
      health: 1,
      capacity: 0.1,
      privacy: 0.5,
      estimatedLatencyMs: -10,
      estimatedCostUsd: 0.01
    }]
  });

  assert.equal(result.route, "none");
  assert.equal(result.rejected[0].reasons.includes("latency_estimate_missing"), true);
});


test("negative capacity telemetry is rejected rather than rewarded as headroom", () => {
  const result = decide({
    workload: { type: "batch", sensitivity: "low" },
    targets: [{
      id: "negative-capacity",
      mode: "local",
      available: true,
      health: 1,
      capacity: -0.1,
      privacy: 1,
      estimatedLatencyMs: 20,
      estimatedCostUsd: 0
    }]
  });

  assert.equal(result.route, "none");
  assert.equal(result.rejected[0].reasons.includes("invalid_capacity_telemetry"), true);
});

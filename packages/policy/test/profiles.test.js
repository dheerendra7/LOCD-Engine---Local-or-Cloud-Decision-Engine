import test from "node:test";
import assert from "node:assert/strict";
import {
  getPolicyProfile,
  listPolicyProfiles,
  resolvePolicy
} from "../src/index.js";

test("balanced profile is deterministic", () => {
  const a = getPolicyProfile("balanced");
  const b = getPolicyProfile("balanced");
  assert.deepEqual(a, b);
  assert.equal(a.id, "balanced");
});

test("policy profiles are enumerable for UI clients", () => {
  const profiles = listPolicyProfiles();
  assert.equal(profiles.length >= 5, true);
  assert.equal(profiles.some(profile => profile.id === "privacyFirst"), true);
});

test("request policy can override preset fields without losing default weights", () => {
  const policy = resolvePolicy({
    profile: "costFirst",
    sensitiveDataMode: "prefer-local",
    weights: { latency: 0.30 }
  });
  assert.equal(policy.sensitiveDataMode, "prefer-local");
  assert.equal(policy.weights.cost, 0.45);
  assert.equal(policy.weights.latency, 0.30);
});

test("unknown profiles fail clearly", () => {
  assert.throws(
    () => getPolicyProfile("does-not-exist"),
    /unknown policy profile/
  );
});

test("resolvePolicy applies matching rules in deterministic priority order", () => {
  const resolved = resolvePolicy({
    profile: "balanced",
    rules: [
      {
        id: "low",
        priority: 1,
        when: { workloadType: "legal" },
        set: { sensitiveDataMode: "prefer-local" }
      },
      {
        id: "high",
        priority: 10,
        when: { workloadType: "legal" },
        set: { sensitiveDataMode: "private-only" }
      }
    ]
  }, {
    workload: { type: "legal", sensitivity: "high" }
  });

  assert.equal(resolved.sensitiveDataMode, "private-only");
  assert.deepEqual(resolved.matchedRules, ["low", "high"]);
});

test("non-matching policy rules do not mutate resolved policy", () => {
  const resolved = resolvePolicy({
    sensitiveDataMode: "balanced",
    rules: [{
      id: "finance-only",
      priority: 100,
      when: { workloadType: "finance" },
      set: { sensitiveDataMode: "private-only" }
    }]
  }, {
    workload: { type: "general", sensitivity: "low" }
  });

  assert.equal(resolved.sensitiveDataMode, "balanced");
  assert.deepEqual(resolved.matchedRules, []);
});

test("resolvePolicy rejects invalid root policy controls", () => {
  assert.equal(
    resolvePolicy({ profile: "privacyFirst", sensitiveDataMode: null }).sensitiveDataMode,
    "private-only"
  );
  assert.deepEqual(
    resolvePolicy({ profile: "privacyFirst", allowedModes: null }).allowedModes,
    ["local", "private", "cloud", "hybrid"]
  );
  assert.throws(
    () => resolvePolicy({ sensitiveDataMode: "cloud-only" }),
    /policy.sensitiveDataMode must be one of/
  );
  assert.throws(
    () => resolvePolicy({ maxHeartbeatAgeMs: -1 }),
    /policy.maxHeartbeatAgeMs must be >= 0/
  );
  assert.throws(
    () => resolvePolicy({ maxHeartbeatAgeMs: " " }),
    /policy.maxHeartbeatAgeMs must be >= 0/
  );
});

test("invalid policy rule shapes fail before decision evaluation", () => {
  assert.throws(
    () => resolvePolicy({
      rules: [{ id: "missing-set", when: { workloadType: "x" } }]
    }, { workload: { type: "x" } }),
    /policy rule set must be an object/
  );

  assert.throws(
    () => resolvePolicy({
      rules: [{ id: "bad-priority", priority: 1.5, set: { sensitiveDataMode: "balanced" } }]
    }, { workload: { type: "x" } }),
    /priority must be an integer/
  );

  assert.throws(
    () => resolvePolicy({
      rules: [{ id: "blank-priority", priority: " ", set: { sensitiveDataMode: "balanced" } }]
    }, { workload: { type: "x" } }),
    /priority must be an integer/
  );

  assert.throws(
    () => resolvePolicy({
      rules: [{ id: "blank-freshness", priority: 1, set: { maxHeartbeatAgeMs: " " } }]
    }, { workload: { type: "x" } }),
    /policy rule maxHeartbeatAgeMs must be >= 0/
  );

  assert.throws(
    () => resolvePolicy({ weights: { cost: null } }, { workload: { type: "x" } }),
    /policy weight must be between 0 and 1: cost/
  );
  assert.throws(
    () => resolvePolicy({ weights: { latency: " " } }, { workload: { type: "x" } }),
    /policy weight must be between 0 and 1: latency/
  );
  assert.throws(
    () => resolvePolicy({
      rules: [{ id: "blank-weight", priority: 1, set: { weights: { cost: " " } } }]
    }, { workload: { type: "x" } }),
    /policy weight must be between 0 and 1: cost/
  );
});

test("rule capability matching requires all declared capabilities", () => {
  const matched = resolvePolicy({
    rules: [{
      id: "vision-and-text",
      priority: 1,
      when: { requiredCapability: ["vision", "text-generation"] },
      set: { allowedModes: ["private"] }
    }]
  }, {
    workload: {
      type: "vision",
      sensitivity: "low",
      requiredCapabilities: ["vision", "text-generation"]
    }
  });

  const unmatched = resolvePolicy({
    rules: [{
      id: "vision-and-text",
      priority: 1,
      when: { requiredCapability: ["vision", "text-generation"] },
      set: { allowedModes: ["private"] }
    }]
  }, {
    workload: {
      type: "vision",
      sensitivity: "low",
      requiredCapabilities: ["vision"]
    }
  });

  assert.deepEqual(matched.matchedRules, ["vision-and-text"]);
  assert.deepEqual(unmatched.matchedRules, []);
});

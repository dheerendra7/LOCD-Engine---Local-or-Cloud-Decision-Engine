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

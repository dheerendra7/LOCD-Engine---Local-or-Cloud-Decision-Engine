import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionPlanAuthorizer } from "../src/authorization.js";

const SECRET = "test-execution-plan-secret-with-at-least-32-bytes";

function validPlan() {
  return {
    planVersion: "1.0",
    route: "hybrid",
    valid: true,
    steps: [
      { id: "prepare", targetId: "local", mode: "local", dataSensitivity: "low" },
      { id: "infer", targetId: "private", mode: "private", dataSensitivity: "low" }
    ]
  };
}

function validRequest() {
  return {
    workload: { type: "authorization-test", sensitivity: "low" },
    constraints: { strictLatency: true, maxLatencyMs: 1000 },
    policy: { allowedModes: ["local", "private"] },
    steps: [
      { id: "prepare", targetId: "local", dataSensitivity: "low" },
      { id: "infer", targetId: "private", dataSensitivity: "low" }
    ]
  };
}

test("signed execution plans verify for the issuing tenant", () => {
  let now = 1_000;
  const authorizer = createExecutionPlanAuthorizer({
    secret: SECRET,
    ttlMs: 5_000,
    clock: () => now
  });
  const plan = validPlan();
  const issued = authorizer.issue({
    tenantId: "acme",
    plan,
    request: validRequest()
  });

  const verified = authorizer.verify({
    token: issued.token,
    tenantId: "acme",
    plan
  });
  assert.equal(verified.authorized, true);
  assert.equal(verified.expiresAt, 6_000);
  assert.deepEqual(verified.request, validRequest());
});

test("execution plan signatures allow step payloads but bind every routing and policy field", () => {
  const authorizer = createExecutionPlanAuthorizer({ secret: SECRET });
  const plan = validPlan();
  const issued = authorizer.issue({
    tenantId: "acme",
    plan,
    request: validRequest()
  });

  const withPayload = structuredClone(plan);
  withPayload.steps[0].payload = { prompt: "private input" };
  assert.equal(authorizer.verify({
    token: issued.token,
    tenantId: "acme",
    plan: withPayload
  }).authorized, true);

  const rerouted = structuredClone(withPayload);
  rerouted.steps[0].targetId = "unapproved-provider";
  assert.deepEqual(authorizer.verify({
    token: issued.token,
    tenantId: "acme",
    plan: rerouted
  }), { authorized: false, error: "execution_plan_mismatch" });

  const policyTamper = structuredClone(withPayload);
  policyTamper.steps[0].dataSensitivity = "low";
  policyTamper.steps[1].mode = "cloud";
  assert.deepEqual(authorizer.verify({
    token: issued.token,
    tenantId: "acme",
    plan: policyTamper
  }), { authorized: false, error: "execution_plan_mismatch" });
});

test("execution plan authorization cannot be replayed across tenants", () => {
  const authorizer = createExecutionPlanAuthorizer({ secret: SECRET });
  const plan = validPlan();
  const issued = authorizer.issue({
    tenantId: "acme",
    plan,
    request: validRequest()
  });

  assert.deepEqual(authorizer.verify({
    token: issued.token,
    tenantId: "beta",
    plan
  }), { authorized: false, error: "execution_plan_tenant_mismatch" });
});

test("expired execution plan authorizations fail closed", () => {
  let now = 1_000;
  const authorizer = createExecutionPlanAuthorizer({
    secret: SECRET,
    ttlMs: 100,
    clock: () => now
  });
  const plan = validPlan();
  const issued = authorizer.issue({
    tenantId: "acme",
    plan,
    request: validRequest()
  });

  now = issued.expiresAt;
  assert.deepEqual(authorizer.verify({
    token: issued.token,
    tenantId: "acme",
    plan
  }), { authorized: false, error: "execution_plan_authorization_expired" });
});

test("malformed signatures and tokens fail closed", () => {
  const authorizer = createExecutionPlanAuthorizer({ secret: SECRET });
  const plan = validPlan();
  const issued = authorizer.issue({
    tenantId: "acme",
    plan,
    request: validRequest()
  });

  assert.deepEqual(authorizer.verify({
    token: issued.token.slice(0, -2) + "xx",
    tenantId: "acme",
    plan
  }), { authorized: false, error: "execution_plan_authorization_invalid" });
  assert.deepEqual(authorizer.verify({
    token: "not-a-token",
    tenantId: "acme",
    plan
  }), { authorized: false, error: "execution_plan_authorization_invalid" });
});

test("execution plan authorizer validates secret, TTL and clock configuration", () => {
  assert.throws(
    () => createExecutionPlanAuthorizer({ secret: "too-short" }),
    /at least 32 bytes/
  );
  assert.throws(
    () => createExecutionPlanAuthorizer({ secret: SECRET, ttlMs: 0 }),
    /between 1 and 900000/
  );
  assert.throws(
    () => createExecutionPlanAuthorizer({ secret: SECRET, ttlMs: 900_001 }),
    /between 1 and 900000/
  );
  assert.throws(
    () => createExecutionPlanAuthorizer({ secret: SECRET, clock: "not-a-clock" }),
    /clock must be a function/
  );
});

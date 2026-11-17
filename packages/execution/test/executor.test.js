import test from "node:test";
import assert from "node:assert/strict";
import {
  createDryRunExecutionAdapter,
  createExecutionRegistry,
  createTenantExecutionRegistry,
  executePlan
} from "../src/index.js";

function plan() {
  return {
    planVersion: "1.0",
    valid: true,
    route: "hybrid",
    steps: [
      { id: "pre", targetId: "local", purpose: "preprocess" },
      { id: "infer", targetId: "private", purpose: "inference" }
    ]
  };
}

test("dry-run execution returns metadata-only receipts", async () => {
  const registry = createExecutionRegistry([
    { ...createDryRunExecutionAdapter({ id: "local-dry", targetId: "local" }), dryRunOnly: true },
    { ...createDryRunExecutionAdapter({ id: "private-dry", targetId: "private" }), dryRunOnly: true }
  ]);

  const result = await executePlan(plan(), {
    registry,
    mode: "dry-run",
    clock: () => new Date("2026-10-01T00:00:00Z")
  });

  assert.equal(result.executionVersion, "1.0");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.status, "completed");
  assert.equal(result.completedSteps, 2);
  assert.deepEqual(result.receipts.map(item => item.status), ["completed", "completed"]);
  assert.equal("payload" in result.receipts[0], false);
});

test("missing execution adapter fails the step", async () => {
  const registry = createExecutionRegistry([
    createDryRunExecutionAdapter({ id: "local-dry", targetId: "local" })
  ]);

  const result = await executePlan(plan(), { registry });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStepId, "infer");
  assert.equal(result.receipts[1].errorClass, "execution_adapter_missing");
});

test("failFast controls whether later stages execute after a failure", async () => {
  const calls = [];
  const registry = createExecutionRegistry([
    {
      id: "local",
      targetId: "local",
      async execute() {
        calls.push("local");
        throw new Error("provider_down");
      }
    },
    {
      id: "private",
      targetId: "private",
      async execute() {
        calls.push("private");
      }
    }
  ]);

  const failFast = await executePlan(plan(), { registry, failFast: true });
  assert.equal(failFast.receipts.length, 1);
  assert.deepEqual(calls, ["local"]);

  calls.length = 0;
  const continueOnFailure = await executePlan(plan(), { registry, failFast: false });
  assert.equal(continueOnFailure.receipts.length, 2);
  assert.deepEqual(calls, ["local", "private"]);
});

test("live execution refuses dry-run-only adapters", async () => {
  const registry = createExecutionRegistry([
    { ...createDryRunExecutionAdapter({ id: "local", targetId: "local" }), dryRunOnly: true }
  ]);

  const oneStep = {
    ...plan(),
    steps: [plan().steps[0]]
  };

  const result = await executePlan(oneStep, { registry, mode: "live" });
  assert.equal(result.status, "failed");
  assert.equal(result.receipts[0].errorClass, "execution_adapter_dry_run_only");
});

test("execution timeout is classified without leaking adapter errors", async () => {
  const registry = createExecutionRegistry([
    {
      id: "slow",
      targetId: "local",
      async execute() {
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
  ]);

  const result = await executePlan(
    { ...plan(), steps: [plan().steps[0]] },
    { registry, timeoutMs: 5 }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.receipts[0].errorClass, "execution_timeout");
});

test("registry rejects duplicate target adapters", () => {
  const registry = createExecutionRegistry([
    createDryRunExecutionAdapter({ id: "one", targetId: "local" })
  ]);

  assert.throws(
    () => registry.register(createDryRunExecutionAdapter({ id: "two", targetId: "local" })),
    /already registered/
  );
});

test("execution admission can reject an open circuit without calling the provider", async () => {
  let providerCalls = 0;
  const registry = createExecutionRegistry([{
    id: "provider",
    targetId: "local",
    async execute() {
      providerCalls++;
      return { ok: true };
    }
  }]);
  let admitted = 0;

  const result = await executePlan(
    { ...plan(), steps: [plan().steps[0]] },
    {
      registry,
      mode: "live",
      beforeStep: async () => {
        admitted++;
        return { allowed: false, errorClass: "circuit_breaker_open" };
      }
    }
  );

  assert.equal(admitted, 1);
  assert.equal(providerCalls, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.receipts[0].errorClass, "circuit_breaker_open");
});

test("execution step callbacks receive provider success and failure exactly once", async () => {
  const registry = createExecutionRegistry([
    {
      id: "success",
      targetId: "local",
      async execute() { return { ok: true }; }
    },
    {
      id: "failure",
      targetId: "private",
      async execute() { throw new Error("provider_unavailable"); }
    }
  ]);
  const outcomes = [];
  const result = await executePlan(plan(), {
    registry,
    mode: "live",
    failFast: false,
    beforeStep: async ({ step }) => ({ allowed: true, context: { permitId: step.id } }),
    onStepResult: async event => outcomes.push({
      stepId: event.step.id,
      status: event.status,
      permitId: event.executionContext.permitId,
      errorClass: event.errorClass ?? null
    })
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(outcomes, [
    { stepId: "pre", status: "completed", permitId: "pre", errorClass: null },
    { stepId: "infer", status: "failed", permitId: "infer", errorClass: "provider_unavailable" }
  ]);
});

test("execution timeout is reported to the failure callback", async () => {
  const registry = createExecutionRegistry([{
    id: "slow",
    targetId: "local",
    async execute() {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }]);
  const outcomes = [];
  const result = await executePlan(
    { ...plan(), steps: [plan().steps[0]] },
    {
      registry,
      mode: "live",
      timeoutMs: 5,
      onStepResult: event => outcomes.push(event.errorClass)
    }
  );

  assert.equal(result.receipts[0].errorClass, "execution_timeout");
  assert.deepEqual(outcomes, ["execution_timeout"]);
});


test("execution outputs are caller-scoped and omitted by default", async () => {
  const registry = createExecutionRegistry([{
    id: "provider",
    targetId: "local",
    async execute({ payload }) {
      return { echoed: payload.prompt };
    }
  }]);

  const planWithPayload = {
    ...plan(),
    steps: [{ id: "infer", targetId: "local", purpose: "inference", payload: { prompt: "hello" } }]
  };

  const hidden = await executePlan(planWithPayload, { registry });
  assert.deepEqual(hidden.results, []);
  assert.equal("payload" in hidden.receipts[0], false);

  const visible = await executePlan(planWithPayload, {
    registry,
    includeOutputs: true
  });
  assert.deepEqual(visible.results, [{
    stepId: "infer",
    targetId: "local",
    result: { echoed: "hello" }
  }]);
  assert.equal("payload" in visible.receipts[0], false);
});


test("tenant execution registries isolate identical target IDs", () => {
  const registry = createTenantExecutionRegistry();
  registry.forTenant("acme").register({
    id: "acme-provider",
    targetId: "shared-target",
    async execute() { return { tenant: "acme" }; }
  });
  registry.forTenant("beta").register({
    id: "beta-provider",
    targetId: "shared-target",
    async execute() { return { tenant: "beta" }; }
  });

  assert.equal(registry.forTenant("acme").get("shared-target").id, "acme-provider");
  assert.equal(registry.forTenant("beta").get("shared-target").id, "beta-provider");
  assert.equal(registry.get("shared-target"), null);
  assert.deepEqual(registry.listTenantIds(), ["acme", "beta", "default"]);
});

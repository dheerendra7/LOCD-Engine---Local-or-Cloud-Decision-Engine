import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresStateStores } from "../src/index.js";
import { createTenantTargetRegistry } from "../../tenancy/src/index.js";

const connectionString = process.env.LOCD_TEST_DATABASE_URL || null;

test("Postgres backend persists tenant state and provides atomic shared coordination", {
  skip: !connectionString
}, async () => {
  const stores = await createPostgresStateStores({
    connectionString,
    maxEntries: 200,
    maxVersionsPerPolicy: 5
  });
  const suffix = randomUUID().replaceAll("-", "");
  const decisionId = "pg-decision-" + suffix;
  const targetId = "pg-target-" + suffix;
  const policyId = "pg-policy-" + suffix;
  const claimKey = "pg-claim-" + suffix;
  const counterKey = "pg-counter-" + suffix;

  let reopened;
  try {
    assert.deepEqual(stores.capabilities, {
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: true,
      backend: "postgres"
    });
    assert.equal(await stores.ping(), true);

    const baseEvent = {
      id: decisionId,
      route: "local",
      workloadType: "postgres-integration",
      targetId,
      confidence: 0.95,
      estimatedLatencyMs: 35,
      estimatedCostUsd: 0.002
    };
    await stores.telemetry.record({ ...baseEvent, tenantId: "acme" });
    await stores.telemetry.record({ ...baseEvent, tenantId: "beta" });

    assert.equal((await stores.telemetry.list({ tenantId: "acme" })).length, 1);
    assert.equal((await stores.telemetry.list({ tenantId: "beta" })).length, 1);
    assert.equal((await stores.telemetry.summary({ tenantId: "acme" })).totalDecisions, 1);

    const completed = await stores.telemetry.recordOutcome(decisionId, {
      outcome: "success",
      actualLatencyMs: 31,
      actualCostUsd: 0.0021
    }, { tenantId: "acme" });
    assert.equal(completed.outcome, "success");
    assert.equal((await stores.telemetry.list({ tenantId: "beta" }))[0].outcome, "pending");
    await assert.rejects(
      () => stores.telemetry.recordOutcome(decisionId, { outcome: "failure" }, { tenantId: "acme" }),
      /decision_already_completed/
    );

    const firstPolicy = await stores.policies.upsert("acme", {
      id: policyId,
      name: "Acme local placement",
      baseProfile: "balanced",
      allowedModes: ["local"]
    }, { updatedBy: "integration-test" });
    assert.equal(firstPolicy.version, 1);

    const secondPolicy = await stores.policies.upsert("acme", {
      id: policyId,
      name: "Acme local and private",
      baseProfile: "balanced",
      allowedModes: ["local", "private"]
    }, { updatedBy: "integration-test" });
    assert.equal(secondPolicy.version, 2);
    assert.equal((await stores.policies.get("beta", policyId)), null);

    const rolledBack = await stores.policies.rollback(
      "acme",
      policyId,
      1,
      { updatedBy: "rollback-test" }
    );
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.rolledBackFromVersion, 1);
    assert.deepEqual(rolledBack.policy.allowedModes, ["local"]);

    const inserted = await Promise.all(
      Array.from({ length: 12 }, () => stores.coordination.setIfAbsent(
        claimKey,
        { owner: "one" },
        { ttlMs: 10_000 }
      ))
    );
    assert.equal(inserted.filter(Boolean).length, 1);
    assert.deepEqual(await stores.coordination.get(claimKey), { owner: "one" });

    assert.equal(await stores.coordination.setIfValue(
      claimKey,
      { owner: "one" },
      { owner: "two" },
      { ttlMs: 10_000 }
    ), true);
    assert.equal(await stores.coordination.setIfValue(
      claimKey,
      { owner: "one" },
      { owner: "stale" }
    ), false);
    assert.equal(await stores.coordination.deleteIfValue(claimKey, { owner: "two" }), true);
    assert.equal(await stores.coordination.deleteIfValue(claimKey, { owner: "two" }), false);

    const increments = await Promise.all(
      Array.from({ length: 20 }, () => stores.coordination.incr(counterKey, { ttlMs: 10_000 }))
    );
    assert.equal(Math.max(...increments), 20);
    assert.equal(new Set(increments).size, 20);

    const target = {
      id: targetId,
      mode: "local",
      available: true,
      health: 0.99,
      capacity: 0.15,
      privacy: 1,
      estimatedLatencyMs: 30,
      estimatedCostUsd: 0,
      capabilities: ["text-generation"]
    };
    await stores.targets.upsert("acme", target);
    await stores.targets.upsert("beta", { ...target, health: 0.8 });
    const targetRegistry = createTenantTargetRegistry();
    assert.equal(await stores.targets.loadInto(targetRegistry), 2);
    assert.equal((await targetRegistry.forTenant("acme").get(targetId)).health, 0.99);
    assert.equal((await targetRegistry.forTenant("beta").get(targetId)).health, 0.8);

    await stores.close();
    reopened = await createPostgresStateStores({ connectionString, maxEntries: 200 });
    assert.equal((await reopened.telemetry.list({ tenantId: "acme" }))[0].outcome, "success");
    assert.equal((await reopened.telemetry.list({ tenantId: "beta" }))[0].outcome, "pending");
    assert.equal((await reopened.policies.get("acme", policyId)).version, 3);
    assert.deepEqual(await reopened.coordination.get(counterKey), 20);
    assert.equal((await reopened.targets.listAll()).length >= 2, true);

    assert.equal(await reopened.targets.remove("acme", targetId), true);
    assert.equal((await reopened.targets.listAll()).some(entry =>
      entry.tenantId === "acme" && entry.snapshot.id === targetId
    ), false);
    assert.equal((await reopened.targets.listAll()).some(entry =>
      entry.tenantId === "beta" && entry.snapshot.id === targetId
    ), true);
  } finally {
    if (reopened) {
      await reopened.telemetry.clear();
      await reopened.policies.remove("acme", policyId);
      await reopened.policies.remove("beta", policyId);
      await reopened.coordination.delete(claimKey);
      await reopened.coordination.delete(counterKey);
      await reopened.targets.clear();
      await reopened.close();
    } else {
      await stores.telemetry.clear();
      await stores.policies.remove("acme", policyId);
      await stores.coordination.delete(claimKey);
      await stores.coordination.delete(counterKey);
      await stores.targets.clear();
      await stores.close();
    }
  }
});

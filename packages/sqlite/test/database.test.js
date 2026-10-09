import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSQLiteCoordinationStore,
  createSQLiteDecisionStore,
  createSQLitePolicyStore,
  createSQLiteStateStores,
  backupSQLiteDatabase
} from "../src/index.js";

test("sqlite online backup creates a restorable database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-backup-"));
  const source = path.join(dir, "state.db");
  const destination = path.join(dir, "backups", "state-copy.db");

  try {
    const stores = createSQLiteStateStores({ filePath: source, maxEntries: 10 });
    stores.telemetry.record({
      id: "backup-decision",
      route: "local",
      workloadType: "backup-test"
    });
    await stores.coordination.set("backup-key", { ok: true });
    stores.close();

    const result = await backupSQLiteDatabase({
      sourcePath: source,
      destinationPath: destination
    });

    assert.equal(result.destination, path.resolve(destination));
    assert.ok(result.pages > 0);

    const restored = new DatabaseSync(destination);
    assert.equal(
      restored.prepare("SELECT COUNT(*) AS count FROM decision_events").get().count,
      1
    );
    assert.equal(
      restored.prepare("SELECT value FROM coordination_kv WHERE key = ?").get("backup-key").value,
      JSON.stringify({ ok: true })
    );
    restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite online backup verifies integrity before publish", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-backup-integrity-"));
  const source = path.join(dir, "state.db");
  const destination = path.join(dir, "backup.db");

  try {
    const stores = createSQLiteStateStores({ filePath: source });
    stores.telemetry.record({
      id: "integrity-check",
      route: "local",
      workloadType: "integrity-test"
    });
    stores.close();

    const result = await backupSQLiteDatabase({
      sourcePath: source,
      destinationPath: destination
    });

    assert.ok(result.pages > 0);
    const backup = new DatabaseSync(destination);
    assert.equal(
      backup.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok"
    );
    assert.deepEqual(
      backup.prepare("PRAGMA foreign_key_check").all(),
      []
    );
    backup.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite backup refuses accidental destination overwrite", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-backup-guard-"));
  const source = path.join(dir, "state.db");
  const destination = path.join(dir, "backup.db");

  try {
    const stores = createSQLiteStateStores({ filePath: source });
    stores.close();
    await writeFile(destination, "existing", "utf8");

    await assert.rejects(
      () => backupSQLiteDatabase({ sourcePath: source, destinationPath: destination }),
      /backup destination already exists/
    );

    const result = await backupSQLiteDatabase({
      sourcePath: source,
      destinationPath: destination,
      overwrite: true
    });
    assert.ok(result.pages > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite records component schema versions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-schema-version-"));
  const file = path.join(dir, "state.db");

  try {
    const stores = createSQLiteStateStores({ filePath: file });

    const rows = stores.database.prepare(
      "SELECT component, version FROM locd_schema_migrations ORDER BY component"
    ).all();

    assert.deepEqual(rows, [
      { component: "coordination_kv", version: 1 },
      { component: "decision_events", version: 1 },
      { component: "policy_records", version: 1 }
    ]);

    stores.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite telemetry survives store recreation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-telemetry-"));
  const file = path.join(dir, "state.db");

  try {
    const first = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    first.record({ id: "sqlite-1", route: "local", workloadType: "classification" });
    first.close();

    const second = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    assert.deepEqual(second.list({ limit: 10 }).map(event => event.id), ["sqlite-1"]);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite telemetry records outcomes and summaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-outcome-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    store.record({
      id: "sqlite-outcome",
      route: "cloud",
      workloadType: "llm",
      estimatedLatencyMs: 100,
      estimatedCostUsd: 0.01
    });

    const updated = store.recordOutcome("sqlite-outcome", {
      outcome: "success",
      actualLatencyMs: 125,
      actualCostUsd: 0.012
    });

    assert.equal(updated.outcome, "success");
    assert.equal(store.summary().meanAbsoluteLatencyErrorMs, 25);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite telemetry is bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-bound-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteDecisionStore({ filePath: file, maxEntries: 2 });
    for (const id of ["1", "2", "3"]) {
      store.record({ id, route: "local", workloadType: "batch" });
    }
    assert.deepEqual(store.list({ limit: 10 }).map(event => event.id), ["3", "2"]);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite policy store persists versions and isolates tenants", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-policy-"));
  const file = path.join(dir, "state.db");

  const policy = {
    id: "acme-policy",
    name: "Acme",
    baseProfile: "balanced",
    allowedModes: ["local"]
  };

  try {
    const one = createSQLitePolicyStore({ filePath: file, maxVersionsPerPolicy: 5 });
    const two = createSQLitePolicyStore({ filePath: file, maxVersionsPerPolicy: 5 });

    assert.equal(one.upsert("acme", policy, { updatedBy: "admin" }).version, 1);
    assert.equal(two.upsert("acme", { ...policy, description: "v2" }).version, 2);
    assert.equal(two.upsert("beta", { ...policy, id: "beta-policy" }).version, 1);

    assert.equal(one.get("acme", "acme-policy").version, 2);
    assert.equal(one.list("beta").length, 1);
    assert.equal(one.list("acme").length, 1);

    const rolledBack = one.rollback("acme", "acme-policy", 1, { updatedBy: "rollback" });
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.rolledBackFromVersion, 1);
    assert.equal(rolledBack.policy.name, "Acme");

    two.close();
    one.close();

    const restored = createSQLitePolicyStore({ filePath: file, maxVersionsPerPolicy: 5 });
    assert.equal(restored.get("acme", "acme-policy").version, 3);
    assert.equal(restored.history("acme", "acme-policy").versions.length, 3);
    restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite coordination is shared across separate connections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-coord-"));
  const file = path.join(dir, "state.db");

  try {
    const one = createSQLiteCoordinationStore({ filePath: file });
    const two = createSQLiteCoordinationStore({ filePath: file });

    assert.equal(await one.setIfAbsent("lock", { owner: "one" }), true);
    assert.equal(await two.setIfAbsent("lock", { owner: "two" }), false);
    assert.deepEqual(await two.get("lock"), { owner: "one" });

    assert.equal(await one.incr("counter", { ttlMs: 1000 }), 1);
    assert.equal(await two.incr("counter", { ttlMs: 1000 }), 2);

    one.close();
    two.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite coordination expires state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-expiry-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteCoordinationStore({ filePath: file });
    await store.set("key", { value: 1 }, { ttlMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await store.get("key"), null);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite state factory shares telemetry and coordination on one database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-state-"));
  const file = path.join(dir, "state.db");

  try {
    const stores = createSQLiteStateStores({ filePath: file });
    stores.telemetry.record({ id: "state-1", route: "local", workloadType: "batch" });
    await stores.coordination.set("shared", { ok: true });

    assert.equal(stores.telemetry.list({ limit: 1 })[0].id, "state-1");
    assert.deepEqual(await stores.coordination.get("shared"), { ok: true });
    stores.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite telemetry isolates tenants even when decision IDs are reused", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-tenant-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteDecisionStore({ filePath: file, maxEntries: 20 });

    store.record({
      id: "acme-id",
      tenantId: "acme",
      route: "local",
      workloadType: "llm"
    });
    store.record({
      id: "beta-id",
      tenantId: "beta",
      route: "cloud",
      workloadType: "llm"
    });

    assert.equal(store.list({ tenantId: "acme", limit: 10 }).length, 1);
    assert.equal(store.list({ tenantId: "beta", limit: 10 }).length, 1);
    assert.equal(store.summary({ tenantId: "acme" }).totalDecisions, 1);

    await assert.rejects(
      async () => store.recordOutcome("acme-id", { outcome: "success" }, { tenantId: "gamma" }),
      /decision_not_found/
    );

    const updated = store.recordOutcome(
      "acme-id",
      { outcome: "success", actualLatencyMs: 10 },
      { tenantId: "acme" }
    );
    assert.equal(updated.tenantId, "acme");
    assert.equal(store.list({ tenantId: "beta" })[0].outcome, "pending");

    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite migrates legacy decision tables without tenant columns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-migration-"));
  const file = path.join(dir, "state.db");

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE decision_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        decision_version TEXT NOT NULL,
        workload_type TEXT NOT NULL,
        route TEXT NOT NULL,
        target_id TEXT,
        confidence REAL NOT NULL,
        estimated_latency_ms REAL,
        estimated_cost_usd REAL,
        outcome TEXT NOT NULL,
        actual_latency_ms REAL,
        actual_cost_usd REAL,
        error_class TEXT,
        outcome_timestamp TEXT
      ) STRICT;
    `);
    db.prepare(`
      INSERT INTO decision_events (
        id, timestamp, decision_version, workload_type, route, target_id,
        confidence, estimated_latency_ms, estimated_cost_usd, outcome,
        actual_latency_ms, actual_cost_usd, error_class, outcome_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy",
      new Date().toISOString(),
      "1.0",
      "legacy",
      "local",
      "gpu",
      0.5,
      10,
      0,
      "pending",
      null,
      null,
      null,
      null
    );
    db.close();

    const store = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    const restored = store.list({ tenantId: "default" });
    assert.equal(restored.length, 1);
    assert.equal(restored[0].id, "legacy");

    const migration = store.database.prepare(
      "SELECT component, version FROM locd_schema_migrations WHERE component = ?"
    ).get("decision_events");
    assert.deepEqual(migration, { component: "decision_events", version: 1 });
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

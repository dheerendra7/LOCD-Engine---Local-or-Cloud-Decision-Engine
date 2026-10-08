import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { createDecisionStore, normalizeDecisionEvent } from "../../../packages/telemetry/src/store.js";
import { createPolicyStore } from "../../../packages/policy-store/src/index.js";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";

function resolveDatabasePath(filePath) {
  if (filePath === ":memory:") return filePath;
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function openDatabase(filePath, { timeout = 5000 } = {}) {
  const database = new DatabaseSync(resolveDatabasePath(filePath), { timeout });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  if (filePath !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }
  return database;
}

function purgeExpired(database, now = Date.now()) {
  database.prepare("DELETE FROM coordination_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
}

export function createSQLiteDecisionStore({ filePath, maxEntries = 5000, database = null } = {}) {
  if (!filePath && !database) throw new Error("filePath or database is required");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer");
  }

  const db = database || openDatabase(filePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
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
      outcome_timestamp TEXT,
      target_utilization REAL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_decision_events_timestamp
      ON decision_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_events_target
      ON decision_events(target_id, workload_type);

  `);

  const columns = db.prepare("PRAGMA table_info(decision_events)").all();
  if (!columns.some(column => column.name === "tenant_id")) {
    db.exec("ALTER TABLE decision_events ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'");
  }
  if (!columns.some(column => column.name === "target_utilization")) {
    db.exec("ALTER TABLE decision_events ADD COLUMN target_utilization REAL");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_decision_events_tenant_time
      ON decision_events(tenant_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_decision_events_tenant_target
      ON decision_events(tenant_id, target_id, workload_type);
  `);

  function trim() {
    db.prepare(`
      DELETE FROM decision_events
      WHERE id IN (
        SELECT id FROM decision_events
        ORDER BY timestamp DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxEntries);
  }

  function rowToEvent(row) {
    return normalizeDecisionEvent({
      id: row.id,
      tenantId: row.tenant_id,
      timestamp: row.timestamp,
      decisionVersion: row.decision_version,
      workloadType: row.workload_type,
      route: row.route,
      targetId: row.target_id,
      confidence: row.confidence,
      estimatedLatencyMs: row.estimated_latency_ms,
      estimatedCostUsd: row.estimated_cost_usd,
      outcome: row.outcome,
      actualLatencyMs: row.actual_latency_ms,
      actualCostUsd: row.actual_cost_usd,
      errorClass: row.error_class,
      targetUtilization: row.target_utilization
    });
  }

  return {
    capabilities: Object.freeze({
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: true
    }),

    record(event) {
      const normalized = normalizeDecisionEvent(event);
      db.prepare(`
        INSERT INTO decision_events (
          id, tenant_id, timestamp, decision_version, workload_type, route, target_id,
          confidence, estimated_latency_ms, estimated_cost_usd, outcome,
          actual_latency_ms, actual_cost_usd, error_class, outcome_timestamp, target_utilization
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.id, normalized.tenantId ?? "default", normalized.timestamp, normalized.decisionVersion,
        normalized.workloadType, normalized.route, normalized.targetId,
        normalized.confidence, normalized.estimatedLatencyMs, normalized.estimatedCostUsd,
        normalized.outcome, normalized.actualLatencyMs, normalized.actualCostUsd,
        normalized.errorClass, null, normalized.targetUtilization ?? null
      );
      trim();
      return { ...normalized };
    },

    recordOutcome(id, patch, { tenantId = null } = {}) {
      const row = tenantId == null
        ? db.prepare("SELECT * FROM decision_events WHERE id = ?").get(String(id))
        : db.prepare("SELECT * FROM decision_events WHERE id = ? AND tenant_id = ?").get(
            String(id), normalizeTenantId(tenantId)
          );
      if (!row) throw new Error("decision_not_found");

      const current = rowToEvent(row);
      const updated = createDecisionStore({ maxEntries: 1, initialEvents: [current] })
        .recordOutcome(current.id, patch, { tenantId: current.tenantId });

      db.prepare(`
        UPDATE decision_events
        SET outcome = ?, actual_latency_ms = ?, actual_cost_usd = ?,
            error_class = ?, outcome_timestamp = ?
        WHERE id = ?
      `).run(
        updated.outcome, updated.actualLatencyMs, updated.actualCostUsd,
        updated.errorClass, updated.outcomeTimestamp ?? null, updated.id
      );
      return { ...updated };
    },

    list({ limit = 50, tenantId = null } = {}) {
      const safeLimit = Math.min(maxEntries, Math.max(1, Number(limit) || 50));
      if (tenantId == null) {
        return db.prepare(
          "SELECT * FROM decision_events ORDER BY timestamp DESC, rowid DESC LIMIT ?"
        ).all(safeLimit).map(rowToEvent);
      }
      return db.prepare(
        "SELECT * FROM decision_events WHERE tenant_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?"
      ).all(normalizeTenantId(tenantId), safeLimit).map(rowToEvent);
    },

    summary({ tenantId = null } = {}) {
      const events = tenantId == null
        ? db.prepare(
            "SELECT * FROM decision_events ORDER BY timestamp ASC, rowid ASC LIMIT ?"
          ).all(maxEntries).map(rowToEvent)
        : db.prepare(
            "SELECT * FROM decision_events WHERE tenant_id = ? ORDER BY timestamp ASC, rowid ASC LIMIT ?"
          ).all(normalizeTenantId(tenantId), maxEntries).map(rowToEvent);
      return createDecisionStore({ maxEntries, initialEvents: events }).summary(
        tenantId == null ? {} : { tenantId }
      );
    },

    clear({ tenantId = null } = {}) {
      if (tenantId == null) {
        db.exec("DELETE FROM decision_events");
      } else {
        db.prepare("DELETE FROM decision_events WHERE tenant_id = ?").run(normalizeTenantId(tenantId));
      }
    },

    close() {
      if (!database) db.close();
    },

    database: db
  };
}

export function createSQLitePolicyStore({
  filePath,
  database = null,
  maxVersionsPerPolicy = 20,
  now = () => new Date().toISOString()
} = {}) {
  if (!filePath && !database) throw new Error("filePath or database is required");
  if (!Number.isInteger(maxVersionsPerPolicy) || maxVersionsPerPolicy < 1) {
    throw new Error("maxVersionsPerPolicy must be a positive integer");
  }

  const db = database || openDatabase(filePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_records (
      tenant_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      policy_json TEXT NOT NULL,
      versions_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, policy_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_policy_records_tenant
      ON policy_records(tenant_id, policy_id);
  `);

  const tenant = tenantId => normalizeTenantId(tenantId);
  const policyId = id => String(id || "").trim().toLowerCase();

  function recordFromRow(row) {
    if (!row) return null;
    return {
      id: row.policy_id,
      tenantId: row.tenant_id,
      version: Number(row.version),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      policy: JSON.parse(row.policy_json),
      versions: JSON.parse(row.versions_json)
    };
  }

  function readRow(tenantId, id) {
    return db.prepare(
      "SELECT * FROM policy_records WHERE tenant_id = ? AND policy_id = ?"
    ).get(tenant(tenantId), policyId(id));
  }

  function hydrate(row) {
    const store = createPolicyStore({ maxVersionsPerPolicy, now });
    store.importState({
      version: 1,
      tenants: {
        [row.tenant_id]: {
          policies: {
            [row.policy_id]: recordFromRow(row)
          }
        }
      }
    });
    return store;
  }

  function writeRecord(record) {
    db.prepare(`
      INSERT INTO policy_records (
        tenant_id, policy_id, version, updated_at, updated_by, policy_json, versions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, policy_id) DO UPDATE SET
        version = excluded.version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        policy_json = excluded.policy_json,
        versions_json = excluded.versions_json
    `).run(
      record.tenantId,
      record.id,
      record.version,
      record.updatedAt,
      record.updatedBy,
      JSON.stringify(record.policy),
      JSON.stringify(record.versions)
    );
  }

  return {
    capabilities: Object.freeze({
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: true
    }),

    list(tenantId) {
      return db.prepare(
        "SELECT * FROM policy_records WHERE tenant_id = ? ORDER BY policy_id ASC"
      ).all(tenant(tenantId)).map(recordFromRow);
    },

    get(tenantId, id) {
      return recordFromRow(readRow(tenantId, id));
    },

    history(tenantId, id) {
      const record = recordFromRow(readRow(tenantId, id));
      return record ? { id: record.id, versions: structuredClone(record.versions) } : null;
    },

    effective(tenantId, id) {
      const row = readRow(tenantId, id);
      if (!row) return null;
      return hydrate(row).effective(tenantId, id);
    },

    upsert(tenantId, input, metadata) {
      const normalizedTenantId = tenant(tenantId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = readRow(normalizedTenantId, input?.id);
        const store = existing
          ? hydrate(existing)
          : createPolicyStore({ maxVersionsPerPolicy, now });
        const record = store.upsert(normalizedTenantId, input, metadata);
        writeRecord(record);
        db.exec("COMMIT");
        return record;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    rollback(tenantId, id, version, metadata) {
      const normalizedTenantId = tenant(tenantId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = readRow(normalizedTenantId, id);
        if (!existing) {
          db.exec("ROLLBACK");
          return null;
        }
        const store = hydrate(existing);
        const record = store.rollback(normalizedTenantId, id, version, metadata);
        if (!record) {
          db.exec("ROLLBACK");
          return null;
        }
        writeRecord(record);
        db.exec("COMMIT");
        return record;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    remove(tenantId, id) {
      const result = db.prepare(
        "DELETE FROM policy_records WHERE tenant_id = ? AND policy_id = ?"
      ).run(tenant(tenantId), policyId(id));
      return result.changes === 1;
    },

    clear(tenantId = null) {
      if (tenantId == null) db.exec("DELETE FROM policy_records");
      else db.prepare("DELETE FROM policy_records WHERE tenant_id = ?").run(tenant(tenantId));
    },

    close() {
      if (!database) db.close();
    },

    database: db
  };
}

export function createSQLiteCoordinationStore({ filePath, database = null } = {}) {
  if (!filePath && !database) throw new Error("filePath or database is required");
  const db = database || openDatabase(filePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_coordination_expiry
      ON coordination_kv(expires_at);
  `);

  function validateTtl(ttlMs) {
    if (ttlMs == null) return;
    if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be >= 1");
  }

  function getValue(key) {
    purgeExpired(db);
    const row = db.prepare("SELECT value FROM coordination_kv WHERE key = ?").get(String(key));
    return row ? JSON.parse(row.value) : null;
  }

  return {
    capabilities: Object.freeze({
      durable: true,
      shared: true,
      tenantScoped: true,
      transactional: true
    }),

    async get(key) {
      return getValue(key);
    },

    async set(key, value, { ttlMs = null } = {}) {
      validateTtl(ttlMs);
      purgeExpired(db);
      const expiresAt = ttlMs == null ? null : Date.now() + ttlMs;
      db.prepare(`
        INSERT INTO coordination_kv(key, value, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          expires_at = excluded.expires_at
      `).run(String(key), JSON.stringify(value), expiresAt);
      return true;
    },

    async setIfAbsent(key, value, { ttlMs = null } = {}) {
      validateTtl(ttlMs);
      purgeExpired(db);
      const expiresAt = ttlMs == null ? null : Date.now() + ttlMs;
      const result = db.prepare(
        "INSERT OR IGNORE INTO coordination_kv(key, value, expires_at) VALUES (?, ?, ?)"
      ).run(String(key), JSON.stringify(value), expiresAt);
      return result.changes === 1;
    },

    async delete(key) {
      purgeExpired(db);
      const result = db.prepare("DELETE FROM coordination_kv WHERE key = ?").run(String(key));
      return result.changes === 1;
    },

    async incr(key, { ttlMs = null } = {}) {
      validateTtl(ttlMs);
      db.exec("BEGIN IMMEDIATE");
      try {
        purgeExpired(db);
        const normalized = String(key);
        const row = db.prepare(
          "SELECT value FROM coordination_kv WHERE key = ?"
        ).get(normalized);

        let next;
        if (!row) {
          next = 1;
          const expiresAt = ttlMs == null ? null : Date.now() + ttlMs;
          db.prepare(
            "INSERT INTO coordination_kv(key, value, expires_at) VALUES (?, ?, ?)"
          ).run(normalized, JSON.stringify(next), expiresAt);
        } else {
          next = Number(row.value) + 1;
          if (!Number.isSafeInteger(next)) throw new Error("coordination counter overflow");
          db.prepare("UPDATE coordination_kv SET value = ? WHERE key = ?").run(JSON.stringify(next), normalized);
        }

        db.exec("COMMIT");
        return next;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async clear() {
      db.exec("DELETE FROM coordination_kv");
    },

    close() {
      if (!database) db.close();
    },

    database: db
  };
}

export function createSQLiteStateStores({
  filePath,
  maxEntries = 5000,
  maxVersionsPerPolicy = 20
} = {}) {
  const db = openDatabase(filePath);
  return {
    database: db,
    telemetry: createSQLiteDecisionStore({ database: db, maxEntries }),
    coordination: createSQLiteCoordinationStore({ database: db }),
    policies: createSQLitePolicyStore({ database: db, maxVersionsPerPolicy }),
    close() { db.close(); }
  };
}
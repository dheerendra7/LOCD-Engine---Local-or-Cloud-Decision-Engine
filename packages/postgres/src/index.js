import { createDecisionStore, normalizeDecisionEvent } from "../../telemetry/src/store.js";
import { createPolicyStore } from "../../policy-store/src/store.js";
import { normalizeTenantId } from "../../tenancy/src/context.js";

const SCHEMA_LOCK_NAME = "locd-state-schema-v1";

function rowsOf(result) {
  return Array.isArray(result) ? result : [];
}

function jsonValue(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value == null ? null : structuredClone(value);
}

function expiryFromTtl(ttlMs) {
  if (ttlMs == null) return null;
  if (!Number.isFinite(ttlMs) || ttlMs < 1) {
    throw new Error("ttlMs must be >= 1");
  }
  const expiresAt = Date.now() + ttlMs;
  if (!Number.isSafeInteger(Math.ceil(expiresAt))) {
    throw new Error("ttlMs exceeds supported expiry range");
  }
  return new Date(expiresAt);
}

function assertSqlClient(sql) {
  if (!sql || typeof sql.unsafe !== "function" || typeof sql.begin !== "function") {
    throw new Error("Postgres client must implement unsafe() and begin()");
  }
  return sql;
}

async function migrate(sql) {
  await sql.begin(async tx => {
    await tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [SCHEMA_LOCK_NAME]
    );

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS locd_schema_migrations (
        component TEXT NOT NULL,
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (component, version)
      )
    `);

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS locd_decision_events (
        tenant_id TEXT NOT NULL,
        id TEXT NOT NULL,
        event JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, id)
      )
    `);
    await tx.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_locd_decisions_tenant_time
      ON locd_decision_events (tenant_id, ((event->>'timestamp')) DESC, created_at DESC)
    `);

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS locd_policy_records (
        tenant_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        policy_json JSONB NOT NULL,
        versions_json JSONB NOT NULL,
        PRIMARY KEY (tenant_id, policy_id)
      )
    `);

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS locd_coordination_kv (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ
      )
    `);
    await tx.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_locd_coordination_expiry
      ON locd_coordination_kv (expires_at)
    `);

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS locd_targets (
        tenant_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, target_id)
      )
    `);
    await tx.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_locd_targets_tenant
      ON locd_targets (tenant_id, target_id)
    `);

    for (const component of ["decision_events", "policy_records", "coordination_kv", "targets"]) {
      await tx.unsafe(
        "INSERT INTO locd_schema_migrations(component, version) VALUES ($1, 1) ON CONFLICT DO NOTHING",
        [component]
      );
    }
  });
}

export function createPostgresDecisionStore({
  sql,
  maxEntries = 5000
} = {}) {
  assertSqlClient(sql);
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive integer");
  }

  const capabilities = Object.freeze({
    durable: true,
    shared: true,
    tenantScoped: true,
    transactional: true,
    backend: "postgres"
  });

  async function list({ limit = 50, tenantId = null } = {}) {
    const safeLimit = Math.min(maxEntries, Math.max(1, Math.floor(Number(limit) || 50)));
    const normalizedTenant = tenantId == null ? null : normalizeTenantId(tenantId);
    const result = normalizedTenant == null
      ? await sql.unsafe(
          "SELECT event FROM locd_decision_events ORDER BY event->>'timestamp' DESC, created_at DESC LIMIT $1",
          [safeLimit]
        )
      : await sql.unsafe(
          "SELECT event FROM locd_decision_events WHERE tenant_id = $1 ORDER BY event->>'timestamp' DESC, created_at DESC LIMIT $2",
          [normalizedTenant, safeLimit]
        );
    return rowsOf(result).map(row => normalizeDecisionEvent(jsonValue(row.event)));
  }

  return {
    capabilities,

    async record(event) {
      const normalized = normalizeDecisionEvent(event);
      const tenantId = normalized.tenantId ?? "default";
      await sql.begin(async tx => {
        await tx.unsafe(
          "INSERT INTO locd_decision_events(tenant_id, id, event) VALUES ($1, $2, $3::jsonb)",
          [tenantId, normalized.id, JSON.stringify(normalized)]
        );
        await tx.unsafe(`
          DELETE FROM locd_decision_events
          WHERE tenant_id = $1
            AND id IN (
              SELECT id FROM locd_decision_events
              WHERE tenant_id = $1
              ORDER BY event->>'timestamp' DESC, created_at DESC
              OFFSET $2
            )
        `, [tenantId, maxEntries]);
      });
      return { ...normalized };
    },

    async recordOutcome(id, patch, { tenantId = null } = {}) {
      const normalizedId = String(id);
      const normalizedTenant = tenantId == null ? null : normalizeTenantId(tenantId);
      return sql.begin(async tx => {
        const result = normalizedTenant == null
          ? await tx.unsafe(
              "SELECT tenant_id, event FROM locd_decision_events WHERE id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
              [normalizedId]
            )
          : await tx.unsafe(
              "SELECT tenant_id, event FROM locd_decision_events WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
              [normalizedTenant, normalizedId]
            );
        const row = rowsOf(result)[0];
        if (!row) throw new Error("decision_not_found");

        const current = normalizeDecisionEvent(jsonValue(row.event));
        const store = createDecisionStore({ maxEntries: 1, initialEvents: [current] });
        const updated = store.recordOutcome(normalizedId, patch, {
          tenantId: row.tenant_id
        });
        await tx.unsafe(
          "UPDATE locd_decision_events SET event = $3::jsonb WHERE tenant_id = $1 AND id = $2",
          [row.tenant_id, normalizedId, JSON.stringify(updated)]
        );
        return { ...updated };
      });
    },

    list,

    async summary({ tenantId = null } = {}) {
      const normalizedTenant = tenantId == null ? null : normalizeTenantId(tenantId);
      const result = normalizedTenant == null
        ? await sql.unsafe(
            "SELECT event FROM locd_decision_events ORDER BY event->>'timestamp' ASC, created_at ASC LIMIT $1",
            [maxEntries]
          )
        : await sql.unsafe(
            "SELECT event FROM locd_decision_events WHERE tenant_id = $1 ORDER BY event->>'timestamp' ASC, created_at ASC LIMIT $2",
            [normalizedTenant, maxEntries]
          );
      const events = rowsOf(result).map(row => normalizeDecisionEvent(jsonValue(row.event)));
      return createDecisionStore({ maxEntries, initialEvents: events }).summary(
        normalizedTenant == null ? {} : { tenantId: normalizedTenant }
      );
    },

    async clear({ tenantId = null } = {}) {
      if (tenantId == null) {
        await sql.unsafe("DELETE FROM locd_decision_events");
      } else {
        await sql.unsafe(
          "DELETE FROM locd_decision_events WHERE tenant_id = $1",
          [normalizeTenantId(tenantId)]
        );
      }
    }
  };
}

function policyRecordFromRow(row) {
  if (!row) return null;
  return {
    id: row.policy_id,
    tenantId: row.tenant_id,
    version: Number(row.version),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    policy: jsonValue(row.policy_json),
    versions: jsonValue(row.versions_json)
  };
}

function hydratePolicyStore(row, { maxVersionsPerPolicy, now }) {
  const store = createPolicyStore({ maxVersionsPerPolicy, now });
  store.importState({
    version: 1,
    tenants: {
      [row.tenant_id]: {
        policies: {
          [row.policy_id]: policyRecordFromRow(row)
        }
      }
    }
  });
  return store;
}

async function selectPolicyRow(sql, tenantId, id, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  const result = await sql.unsafe(
    "SELECT * FROM locd_policy_records WHERE tenant_id = $1 AND policy_id = $2" + suffix,
    [tenantId, String(id || "").trim().toLowerCase()]
  );
  return rowsOf(result)[0] || null;
}

async function writePolicyRecord(sql, record) {
  await sql.unsafe(`
    INSERT INTO locd_policy_records (
      tenant_id, policy_id, version, updated_at, updated_by, policy_json, versions_json
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
    ON CONFLICT (tenant_id, policy_id) DO UPDATE SET
      version = EXCLUDED.version,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by,
      policy_json = EXCLUDED.policy_json,
      versions_json = EXCLUDED.versions_json
  `, [
    record.tenantId,
    record.id,
    record.version,
    record.updatedAt,
    record.updatedBy ?? null,
    JSON.stringify(record.policy),
    JSON.stringify(record.versions)
  ]);
}

export function createPostgresPolicyStore({
  sql,
  maxVersionsPerPolicy = 20,
  now = () => new Date().toISOString()
} = {}) {
  assertSqlClient(sql);
  if (!Number.isInteger(maxVersionsPerPolicy) || maxVersionsPerPolicy < 1) {
    throw new Error("maxVersionsPerPolicy must be a positive integer");
  }

  const capabilities = Object.freeze({
    durable: true,
    shared: true,
    tenantScoped: true,
    transactional: true,
    backend: "postgres"
  });

  return {
    capabilities,

    async list(tenantId) {
      const result = await sql.unsafe(
        "SELECT * FROM locd_policy_records WHERE tenant_id = $1 ORDER BY policy_id ASC",
        [normalizeTenantId(tenantId)]
      );
      return rowsOf(result).map(policyRecordFromRow);
    },

    async get(tenantId, id) {
      const row = await selectPolicyRow(sql, normalizeTenantId(tenantId), id);
      return policyRecordFromRow(row);
    },

    async history(tenantId, id) {
      const record = policyRecordFromRow(
        await selectPolicyRow(sql, normalizeTenantId(tenantId), id)
      );
      return record ? { id: record.id, versions: structuredClone(record.versions) } : null;
    },

    async effective(tenantId, id) {
      const normalizedTenant = normalizeTenantId(tenantId);
      const row = await selectPolicyRow(sql, normalizedTenant, id);
      if (!row) return null;
      return hydratePolicyStore(row, { maxVersionsPerPolicy, now }).effective(normalizedTenant, id);
    },

    async upsert(tenantId, input, metadata) {
      const normalizedTenant = normalizeTenantId(tenantId);
      return sql.begin(async tx => {
        const policyId = String(input?.id || "").trim().toLowerCase();
        await tx.unsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [normalizedTenant, policyId]
        );
        const existing = await selectPolicyRow(tx, normalizedTenant, policyId, true);
        const store = existing
          ? hydratePolicyStore(existing, { maxVersionsPerPolicy, now })
          : createPolicyStore({ maxVersionsPerPolicy, now });
        const record = store.upsert(normalizedTenant, input, metadata);
        await writePolicyRecord(tx, record);
        return record;
      });
    },

    async rollback(tenantId, id, version, metadata) {
      const normalizedTenant = normalizeTenantId(tenantId);
      return sql.begin(async tx => {
        const policyId = String(id || "").trim().toLowerCase();
        await tx.unsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [normalizedTenant, policyId]
        );
        const existing = await selectPolicyRow(tx, normalizedTenant, policyId, true);
        if (!existing) return null;
        const store = hydratePolicyStore(existing, { maxVersionsPerPolicy, now });
        const record = store.rollback(normalizedTenant, id, version, metadata);
        if (!record) return null;
        await writePolicyRecord(tx, record);
        return record;
      });
    },

    async remove(tenantId, id) {
      const result = await sql.unsafe(
        "DELETE FROM locd_policy_records WHERE tenant_id = $1 AND policy_id = $2 RETURNING policy_id",
        [normalizeTenantId(tenantId), String(id || "").trim().toLowerCase()]
      );
      return rowsOf(result).length === 1;
    },

    async clear(tenantId = null) {
      if (tenantId == null) {
        await sql.unsafe("DELETE FROM locd_policy_records");
      } else {
        await sql.unsafe(
          "DELETE FROM locd_policy_records WHERE tenant_id = $1",
          [normalizeTenantId(tenantId)]
        );
      }
    }
  };
}

export function createPostgresCoordinationStore({ sql } = {}) {
  assertSqlClient(sql);
  const capabilities = Object.freeze({
    durable: true,
    shared: true,
    tenantScoped: true,
    transactional: true,
    backend: "postgres"
  });

  return {
    capabilities,

    async get(key) {
      const result = await sql.unsafe(
        "SELECT value FROM locd_coordination_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())",
        [String(key)]
      );
      return rowsOf(result).length ? jsonValue(result[0].value) : null;
    },

    async set(key, value, { ttlMs = null } = {}) {
      const expiresAt = expiryFromTtl(ttlMs);
      await sql.unsafe(`
        INSERT INTO locd_coordination_kv(key, value, expires_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at
      `, [String(key), JSON.stringify(value), expiresAt]);
      return true;
    },

    async setIfAbsent(key, value, { ttlMs = null } = {}) {
      const expiresAt = expiryFromTtl(ttlMs);
      const result = await sql.unsafe(`
        INSERT INTO locd_coordination_kv(key, value, expires_at)
        VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at
        WHERE locd_coordination_kv.expires_at IS NOT NULL
          AND locd_coordination_kv.expires_at <= NOW()
        RETURNING key
      `, [String(key), JSON.stringify(value), expiresAt]);
      return rowsOf(result).length === 1;
    },

    async setIfValue(key, expectedValue, value, { ttlMs = null } = {}) {
      if (expectedValue === undefined || JSON.stringify(value) === undefined) return false;
      const expiresAt = expiryFromTtl(ttlMs);
      const result = await sql.unsafe(`
        UPDATE locd_coordination_kv
        SET value = $3::jsonb, expires_at = $4
        WHERE key = $1
          AND value = $2::jsonb
          AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING key
      `, [
        String(key),
        JSON.stringify(expectedValue),
        JSON.stringify(value),
        expiresAt
      ]);
      return rowsOf(result).length === 1;
    },

    async delete(key) {
      const result = await sql.unsafe(`
        DELETE FROM locd_coordination_kv
        WHERE key = $1
        RETURNING CASE WHEN expires_at IS NULL OR expires_at > NOW() THEN TRUE ELSE FALSE END AS removed
      `, [String(key)]);
      return rowsOf(result)[0]?.removed === true;
    },

    async deleteIfValue(key, expectedValue) {
      if (expectedValue === undefined) return false;
      const result = await sql.unsafe(`
        DELETE FROM locd_coordination_kv
        WHERE key = $1
          AND value = $2::jsonb
          AND (expires_at IS NULL OR expires_at > NOW())
        RETURNING key
      `, [String(key), JSON.stringify(expectedValue)]);
      return rowsOf(result).length === 1;
    },

    async incr(key, { ttlMs = null } = {}) {
      const expiresAt = expiryFromTtl(ttlMs);
      return sql.begin(async tx => {
        const normalizedKey = String(key);
        await tx.unsafe(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [normalizedKey]
        );
        await tx.unsafe(
          "DELETE FROM locd_coordination_kv WHERE key = $1 AND expires_at IS NOT NULL AND expires_at <= NOW()",
          [normalizedKey]
        );
        const result = await tx.unsafe(
          "SELECT value, expires_at FROM locd_coordination_kv WHERE key = $1 FOR UPDATE",
          [normalizedKey]
        );
        const row = rowsOf(result)[0];
        if (!row) {
          await tx.unsafe(
            "INSERT INTO locd_coordination_kv(key, value, expires_at) VALUES ($1, $2::jsonb, $3)",
            [normalizedKey, "1", expiresAt]
          );
          return 1;
        }

        const current = jsonValue(row.value);
        if (!Number.isSafeInteger(current) || current < 0) {
          throw new Error("coordination counter must be a non-negative safe integer");
        }
        const next = current + 1;
        if (!Number.isSafeInteger(next)) throw new Error("coordination counter overflow");
        const nextExpiry = expiresAt !== null && row.expires_at == null
          ? expiresAt
          : row.expires_at;
        await tx.unsafe(
          "UPDATE locd_coordination_kv SET value = $2::jsonb, expires_at = $3 WHERE key = $1",
          [normalizedKey, JSON.stringify(next), nextExpiry]
        );
        return next;
      });
    },

    async clear() {
      await sql.unsafe("DELETE FROM locd_coordination_kv");
    }
  };
}

export function createPostgresTargetStore({ sql } = {}) {
  assertSqlClient(sql);
  const capabilities = Object.freeze({
    durable: true,
    shared: true,
    tenantScoped: true,
    transactional: true,
    backend: "postgres"
  });

  return {
    capabilities,

    async upsert(tenantId, snapshot) {
      const normalizedTenant = normalizeTenantId(tenantId);
      if (!snapshot || typeof snapshot !== "object" || !snapshot.id) {
        throw new Error("target snapshot with an id is required");
      }
      await sql.unsafe(`
        INSERT INTO locd_targets(tenant_id, target_id, snapshot, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (tenant_id, target_id) DO UPDATE SET
          snapshot = EXCLUDED.snapshot,
          updated_at = NOW()
      `, [normalizedTenant, String(snapshot.id), JSON.stringify(snapshot)]);
      return structuredClone(snapshot);
    },

    async remove(tenantId, targetId) {
      const result = await sql.unsafe(
        "DELETE FROM locd_targets WHERE tenant_id = $1 AND target_id = $2 RETURNING target_id",
        [normalizeTenantId(tenantId), String(targetId)]
      );
      return rowsOf(result).length === 1;
    },

    async listAll() {
      const result = await sql.unsafe(
        "SELECT tenant_id, snapshot FROM locd_targets ORDER BY tenant_id ASC, target_id ASC"
      );
      return rowsOf(result).map(row => ({
        tenantId: normalizeTenantId(row.tenant_id),
        snapshot: jsonValue(row.snapshot)
      }));
    },

    async loadInto(targetRegistry) {
      if (!targetRegistry || typeof targetRegistry.forTenant !== "function") {
        throw new Error("tenant target registry is required");
      }
      const entries = await this.listAll();
      for (const entry of entries) {
        const registry = targetRegistry.forTenant(entry.tenantId);
        if (registry.has(entry.snapshot.id)) registry.remove(entry.snapshot.id);
        registry.register(entry.snapshot);
      }
      return entries.length;
    },

    async clear(tenantId = null) {
      if (tenantId == null) {
        await sql.unsafe("DELETE FROM locd_targets");
      } else {
        await sql.unsafe(
          "DELETE FROM locd_targets WHERE tenant_id = $1",
          [normalizeTenantId(tenantId)]
        );
      }
    }
  };
}

export async function createPostgresStateStores({
  connectionString = process.env.LOCD_DATABASE_URL?.trim() || null,
  client = null,
  maxEntries = 5000,
  maxVersionsPerPolicy = 20,
  maxConnections = Number(process.env.LOCD_DATABASE_POOL_MAX || 10),
  idleTimeoutSeconds = Number(process.env.LOCD_DATABASE_IDLE_TIMEOUT_SECONDS || 20),
  connectTimeoutSeconds = Number(process.env.LOCD_DATABASE_CONNECT_TIMEOUT_SECONDS || 10),
  ssl = process.env.LOCD_DATABASE_SSL?.trim() || undefined,
  now = () => new Date().toISOString()
} = {}) {
  if (!client && !connectionString) {
    throw new Error("LOCD_DATABASE_URL or an injected Postgres client is required");
  }
  for (const [name, value] of [
    ["maxConnections", maxConnections],
    ["idleTimeoutSeconds", idleTimeoutSeconds],
    ["connectTimeoutSeconds", connectTimeoutSeconds]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(name + " must be a positive safe integer");
    }
  }

  let sql = client;
  let ownsClient = false;
  if (!sql) {
    const driver = await import("postgres");
    const postgres = driver.default || driver;
    sql = postgres(connectionString, {
      max: maxConnections,
      idle_timeout: idleTimeoutSeconds,
      connect_timeout: connectTimeoutSeconds,
      ...(ssl ? { ssl } : {}),
      application_name: "locd-api",
      prepare: false
    });
    ownsClient = true;
  }
  assertSqlClient(sql);

  try {
    await migrate(sql);
    return {
      backend: "postgres",
      capabilities: Object.freeze({
        durable: true,
        shared: true,
        tenantScoped: true,
        transactional: true,
        backend: "postgres"
      }),
      telemetry: createPostgresDecisionStore({ sql, maxEntries }),
      policies: createPostgresPolicyStore({ sql, maxVersionsPerPolicy, now }),
      coordination: createPostgresCoordinationStore({ sql }),
      targets: createPostgresTargetStore({ sql }),
      async ping() {
        await sql.unsafe("SELECT 1 AS ok");
        return true;
      },
      async close() {
        if (ownsClient && typeof sql.end === "function") {
          await sql.end({ timeout: 5 });
        }
      }
    };
  } catch (error) {
    if (ownsClient && typeof sql.end === "function") {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
    throw error;
  }
}

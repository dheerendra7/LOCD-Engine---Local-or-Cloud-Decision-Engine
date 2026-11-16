import { randomUUID } from "node:crypto";
import { createInMemoryCoordinationStore } from "../../../packages/coordination/src/index.js";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_FAILURE_WINDOW_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_PROBE_LEASE_MS = 30_000;
const DEFAULT_NAMESPACE = "locd:circuit-breaker:v1";

function validatePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(field + " must be a positive safe integer");
  }
  return value;
}

function keyFor(namespace, tenantId, targetId) {
  return namespace + ":" + encodeURIComponent(normalizeTenantId(tenantId)) +
    ":" + encodeURIComponent(String(targetId));
}

function readClock(clock) {
  const value = Number(clock());
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("circuit breaker clock must return a non-negative timestamp");
  }
  return value;
}

/**
 * Tenant-scoped circuit breaker using atomic compare-and-set coordination.
 * A shared coordination store shares breaker state across API instances.
 */
export function createCircuitBreaker({
  store = createInMemoryCoordinationStore(),
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  probeLeaseMs = DEFAULT_PROBE_LEASE_MS,
  namespace = DEFAULT_NAMESPACE,
  clock = Date.now,
  maxCasAttempts = 32
} = {}) {
  validatePositiveInteger(failureThreshold, "failureThreshold");
  validatePositiveInteger(failureWindowMs, "failureWindowMs");
  validatePositiveInteger(cooldownMs, "cooldownMs");
  validatePositiveInteger(probeLeaseMs, "probeLeaseMs");
  validatePositiveInteger(maxCasAttempts, "maxCasAttempts");
  if (typeof clock !== "function") throw new Error("clock must be a function");
  if (typeof namespace !== "string" || !namespace.trim()) {
    throw new Error("namespace must be a non-empty string");
  }

  const required = ["get", "setIfAbsent", "setIfValue", "deleteIfValue"];
  const missing = required.filter(method => typeof store?.[method] !== "function");
  if (missing.length) {
    throw new Error(
      "circuit breaker store must implement atomic methods: " + missing.join(", ")
    );
  }

  const retentionMs = failureWindowMs + cooldownMs + (probeLeaseMs * 2) + 60_000;

  function stateKey(tenantId, targetId) {
    if (targetId == null || String(targetId).trim() === "") {
      throw new Error("targetId is required");
    }
    return keyFor(namespace, tenantId, targetId);
  }

  async function readState(key) {
    const value = await store.get(key);
    if (value == null) return null;
    if (!value || typeof value !== "object" || !Array.isArray(value.failures)) {
      throw new Error("circuit breaker state is invalid");
    }
    return value;
  }

  async function writeState(key, current, next) {
    return current == null
      ? store.setIfAbsent(key, next, { ttlMs: retentionMs })
      : store.setIfValue(key, current, next, { ttlMs: retentionMs });
  }

  async function deleteState(key, current) {
    return current == null || store.deleteIfValue(key, current);
  }

  function activeFailures(state, now) {
    return (state?.failures || []).filter(timestamp =>
      Number.isFinite(timestamp) && timestamp > now - failureWindowMs
    );
  }

  function describe(state, now) {
    if (!state) {
      return {
        state: "closed",
        failureCount: 0,
        retryAt: null,
        probeInFlight: false
      };
    }

    const failures = activeFailures(state, now);
    const retryAt = Number.isFinite(state.retryAt) ? state.retryAt : null;
    if (state.state === "open" && retryAt !== null && now < retryAt) {
      return {
        state: "open",
        failureCount: failures.length,
        openedAt: state.openedAt ?? null,
        retryAt,
        probeInFlight: false
      };
    }

    if (state.state === "open" || state.state === "half-open") {
      const probeInFlight = Boolean(
        state.probeToken &&
        Number.isFinite(state.probeLeaseExpiresAt) &&
        state.probeLeaseExpiresAt > now
      );
      return {
        state: "half-open",
        failureCount: failures.length,
        openedAt: state.openedAt ?? null,
        retryAt,
        probeInFlight
      };
    }

    return {
      state: "closed",
      failureCount: failures.length,
      retryAt: null,
      probeInFlight: false
    };
  }

  async function inspect(tenantId, targetId) {
    const key = stateKey(tenantId, targetId);
    const state = await readState(key);
    return describe(state, readClock(clock));
  }

  async function annotateTargets(targets = [], tenantId = "default") {
    if (!Array.isArray(targets)) throw new Error("targets must be an array");
    const normalizedTenant = normalizeTenantId(tenantId);
    return Promise.all(targets.map(async target => {
      if (!target || typeof target !== "object" || target.id == null) {
        return structuredClone(target);
      }
      const breaker = await inspect(normalizedTenant, target.id);
      return {
        ...structuredClone(target),
        circuitBreaker: breaker
      };
    }));
  }

  async function acquire(tenantId, targetId) {
    const key = stateKey(tenantId, targetId);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const now = readClock(clock);
      const current = await readState(key);
      const view = describe(current, now);

      if (view.state === "open") {
        return {
          allowed: false,
          reason: "circuit_breaker_open",
          state: view
        };
      }
      if (view.state === "closed") {
        return {
          allowed: true,
          state: view,
          probeToken: null
        };
      }
      if (view.probeInFlight) {
        return {
          allowed: false,
          reason: "circuit_breaker_half_open_busy",
          state: view
        };
      }

      const probeToken = randomUUID();
      const next = {
        state: "half-open",
        failures: activeFailures(current, now),
        openedAt: current?.openedAt ?? now,
        retryAt: current?.retryAt ?? now,
        probeToken,
        probeLeaseExpiresAt: now + probeLeaseMs
      };
      if (await writeState(key, current, next)) {
        return {
          allowed: true,
          state: describe(next, now),
          probeToken
        };
      }
    }
    return {
      allowed: false,
      reason: "circuit_breaker_state_busy",
      state: await inspect(tenantId, targetId)
    };
  }

  async function recordFailure(tenantId, targetId, { probeToken = null } = {}) {
    const key = stateKey(tenantId, targetId);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const now = readClock(clock);
      const current = await readState(key);

      if (probeToken) {
        if (
          current?.state !== "half-open" ||
          current.probeToken !== probeToken
        ) return false;

        const failures = activeFailures(current, now);
        if (failures.length < failureThreshold) {
          while (failures.length < failureThreshold - 1) failures.push(now);
        }
        failures.push(now);
        const next = {
          state: "open",
          failures: failures.slice(-failureThreshold),
          openedAt: now,
          retryAt: now + cooldownMs,
          probeToken: null,
          probeLeaseExpiresAt: null
        };
        if (await writeState(key, current, next)) return true;
        continue;
      }

      // A late failure from an older in-flight request must never overwrite an
      // already-open circuit or steal a half-open probe lease.
      if (current?.state === "open" || current?.state === "half-open") return false;

      const failures = activeFailures(current, now);
      failures.push(now);
      const shouldOpen = failures.length >= failureThreshold;
      const next = shouldOpen
        ? {
            state: "open",
            failures: failures.slice(-failureThreshold),
            openedAt: now,
            retryAt: now + cooldownMs,
            probeToken: null,
            probeLeaseExpiresAt: null
          }
        : {
            state: "closed",
            failures,
            openedAt: null,
            retryAt: null,
            probeToken: null,
            probeLeaseExpiresAt: null
          };
      if (await writeState(key, current, next)) return true;
    }
    return false;
  }

  async function recordSuccess(tenantId, targetId, { probeToken = null } = {}) {
    const key = stateKey(tenantId, targetId);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const current = await readState(key);
      if (!current) return true;

      if (probeToken) {
        if (
          current.state !== "half-open" ||
          current.probeToken !== probeToken
        ) return false;
        if (await deleteState(key, current)) return true;
        continue;
      }

      // A success from a request that started before the circuit opened cannot
      // close the circuit or invalidate an active half-open trial.
      if (current.state !== "closed") return false;
      if (await deleteState(key, current)) return true;
    }
    return false;
  }

  async function snapshot(targets = [], tenantId = "default") {
    if (!Array.isArray(targets)) throw new Error("targets must be an array");
    const states = await annotateTargets(targets, tenantId);
    return {
      total: states.length,
      open: states.filter(item => item?.circuitBreaker?.state === "open").length,
      halfOpen: states.filter(item =>
        item?.circuitBreaker?.state === "half-open"
      ).length,
      closed: states.filter(item => item?.circuitBreaker?.state === "closed").length
    };
  }

  return {
    inspect,
    annotateTargets,
    acquire,
    recordFailure,
    recordSuccess,
    snapshot,
    config: {
      failureThreshold,
      failureWindowMs,
      cooldownMs,
      probeLeaseMs,
      namespace
    }
  };
}

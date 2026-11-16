import { randomUUID } from "node:crypto";
import { createInMemoryCoordinationStore } from "../../../packages/coordination/src/index.js";
import { normalizeTenantId } from "../../../packages/tenancy/src/index.js";

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_FAILURE_WINDOW_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_PROBE_LEASE_MS = 60_000;
const DEFAULT_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_MAX_ENTRIES = 2_000;
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
  maxCasAttempts = 32,
  historyRetentionMs = DEFAULT_HISTORY_RETENTION_MS,
  historyMaxEntries = DEFAULT_HISTORY_MAX_ENTRIES
} = {}) {
  validatePositiveInteger(failureThreshold, "failureThreshold");
  validatePositiveInteger(failureWindowMs, "failureWindowMs");
  validatePositiveInteger(cooldownMs, "cooldownMs");
  validatePositiveInteger(probeLeaseMs, "probeLeaseMs");
  validatePositiveInteger(maxCasAttempts, "maxCasAttempts");
  validatePositiveInteger(historyRetentionMs, "historyRetentionMs");
  validatePositiveInteger(historyMaxEntries, "historyMaxEntries");
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
  if (!Number.isSafeInteger(retentionMs)) {
    throw new Error("circuit breaker timing configuration exceeds the supported range");
  }

  function stateKey(tenantId, targetId) {
    if (targetId == null || String(targetId).trim() === "") {
      throw new Error("targetId is required");
    }
    return keyFor(namespace, tenantId, targetId);
  }

  function historyStorageKey(tenantId) {
    return namespace + ":history:" + encodeURIComponent(normalizeTenantId(tenantId));
  }

  function normalizeSource(source) {
    const value = String(source || "execution");
    return /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : "other";
  }

  let historyWriteFailures = 0;

  async function appendHistoryEvent({
    tenantId,
    targetId,
    type,
    source = "execution",
    timestamp,
    stateFrom = "closed",
    stateTo = "closed",
    transition = null,
    failureCount = 0,
    recoveryDurationMs = null
  }) {
    const key = historyStorageKey(tenantId);
    const event = {
      id: randomUUID(),
      timestamp,
      targetId: String(targetId),
      type,
      source: normalizeSource(source),
      stateFrom,
      stateTo,
      transition,
      failureCount: Number.isSafeInteger(failureCount) && failureCount >= 0
        ? failureCount
        : 0,
      recoveryDurationMs: Number.isFinite(recoveryDurationMs) && recoveryDurationMs >= 0
        ? recoveryDurationMs
        : null
    };

    try {
      for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
        const current = await store.get(key);
        if (current != null && (
          current.version !== 1 ||
          !Array.isArray(current.events) ||
          !Number.isSafeInteger(current.droppedEventCount) ||
          current.droppedEventCount < 0
        )) {
          throw new Error("circuit breaker history is invalid");
        }

        const existingEvents = current?.events || [];
        const nextEvents = [...existingEvents, event];
        const overflow = Math.max(0, nextEvents.length - historyMaxEntries);
        const next = {
          version: 1,
          events: overflow ? nextEvents.slice(overflow) : nextEvents,
          droppedEventCount: (current?.droppedEventCount || 0) + overflow
        };
        const saved = current == null
          ? await store.setIfAbsent(key, next, { ttlMs: historyRetentionMs })
          : await store.setIfValue(key, current, next, { ttlMs: historyRetentionMs });
        if (saved) return true;
      }
    } catch {
      // Observability must never change provider admission or execution outcomes.
    }

    historyWriteFailures = Math.min(Number.MAX_SAFE_INTEGER, historyWriteFailures + 1);
    return false;
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

  async function acquire(tenantId, targetId, { source = "execution" } = {}) {
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
        await appendHistoryEvent({
          tenantId,
          targetId,
          type: "recovery_attempt_started",
          source,
          timestamp: now,
          stateFrom: current?.state === "open" ? "open" : "half-open",
          stateTo: "half-open",
          transition: "probe_admitted",
          failureCount: next.failures.length
        });
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

  async function recordFailure(tenantId, targetId, {
    probeToken = null,
    source = "execution"
  } = {}) {
    const key = stateKey(tenantId, targetId);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const now = readClock(clock);
      const current = await readState(key);

      if (probeToken) {
        if (
          current?.state !== "half-open" ||
          current.probeToken !== probeToken ||
          !Number.isFinite(current.probeLeaseExpiresAt) ||
          current.probeLeaseExpiresAt <= now
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
        if (await writeState(key, current, next)) {
          await appendHistoryEvent({
            tenantId,
            targetId,
            type: "provider_failure",
            source,
            timestamp: now,
            stateFrom: "half-open",
            stateTo: "open",
            transition: "reopened",
            failureCount: failures.length,
            recoveryDurationMs: Math.max(0, now - (current.openedAt ?? now))
          });
          return true;
        }
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
      if (await writeState(key, current, next)) {
        await appendHistoryEvent({
          tenantId,
          targetId,
          type: "provider_failure",
          source,
          timestamp: now,
          stateFrom: "closed",
          stateTo: shouldOpen ? "open" : "closed",
          transition: shouldOpen ? "opened" : null,
          failureCount: failures.length
        });
        return true;
      }
    }
    return false;
  }

  async function recordSuccess(tenantId, targetId, {
    probeToken = null,
    source = "execution"
  } = {}) {
    const key = stateKey(tenantId, targetId);
    for (let attempt = 0; attempt < maxCasAttempts; attempt++) {
      const now = readClock(clock);
      const current = await readState(key);
      if (!current) {
        await appendHistoryEvent({
          tenantId,
          targetId,
          type: "provider_success",
          source,
          timestamp: now
        });
        return true;
      }

      if (probeToken) {
        if (
          current.state !== "half-open" ||
          current.probeToken !== probeToken ||
          !Number.isFinite(current.probeLeaseExpiresAt) ||
          current.probeLeaseExpiresAt <= now
        ) return false;
        if (await deleteState(key, current)) {
          await appendHistoryEvent({
            tenantId,
            targetId,
            type: "provider_success",
            source,
            timestamp: now,
            stateFrom: "half-open",
            stateTo: "closed",
            transition: "recovered",
            failureCount: 0,
            recoveryDurationMs: Math.max(0, now - (current.openedAt ?? now))
          });
          return true;
        }
        continue;
      }

      // A success from a request that started before the circuit opened cannot
      // close the circuit or invalidate an active half-open trial.
      if (current.state !== "closed") return false;
      if (await deleteState(key, current)) {
        await appendHistoryEvent({
          tenantId,
          targetId,
          type: "provider_success",
          source,
          timestamp: now,
          stateFrom: "closed",
          stateTo: "closed",
          failureCount: activeFailures(current, now).length
        });
        return true;
      }
    }
    return false;
  }

  async function history(tenantId = "default", {
    windowMs = 24 * 60 * 60 * 1000,
    limit = 50
  } = {}) {
    validatePositiveInteger(windowMs, "windowMs");
    validatePositiveInteger(limit, "limit");
    if (windowMs > historyRetentionMs) {
      throw new Error("windowMs exceeds circuit breaker history retention");
    }
    if (limit > 100) throw new Error("limit must be <= 100");

    const now = readClock(clock);
    const current = await store.get(historyStorageKey(tenantId));
    if (current != null && (
      current.version !== 1 ||
      !Array.isArray(current.events) ||
      !Number.isSafeInteger(current.droppedEventCount) ||
      current.droppedEventCount < 0
    )) {
      throw new Error("circuit breaker history is invalid");
    }

    const retainedEvents = current?.events || [];
    const from = Math.max(0, now - windowMs);
    const events = retainedEvents
      .filter(event => Number.isFinite(event?.timestamp) && event.timestamp >= from && event.timestamp <= now)
      .sort((left, right) => left.timestamp - right.timestamp);

    const summary = {
      attempts: 0,
      successes: 0,
      failures: 0,
      failureRate: null,
      successRate: null,
      recoveryAttempts: 0,
      circuitOpenings: 0,
      recoveries: 0,
      averageRecoveryDurationMs: null
    };
    const providerMap = new Map();
    const recoveryDurations = [];
    const bucketCount = 24;
    const bucketWidth = windowMs / bucketCount;
    const timeline = Array.from({ length: bucketCount }, (_, index) => ({
      bucketStart: Math.floor(from + index * bucketWidth),
      bucketEnd: Math.floor(from + (index + 1) * bucketWidth),
      successes: 0,
      failures: 0,
      recoveryAttempts: 0,
      circuitOpenings: 0,
      recoveries: 0
    }));

    for (const event of events) {
      const provider = providerMap.get(event.targetId) || {
        targetId: event.targetId,
        attempts: 0,
        successes: 0,
        failures: 0,
        failureRate: null,
        recoveryAttempts: 0,
        circuitOpenings: 0,
        recoveries: 0,
        averageRecoveryDurationMs: null,
        lastFailureAt: null,
        lastEventAt: event.timestamp
      };
      provider.lastEventAt = Math.max(provider.lastEventAt || 0, event.timestamp);

      const bucketIndex = Math.min(
        bucketCount - 1,
        Math.max(0, Math.floor((event.timestamp - from) / bucketWidth))
      );
      const bucket = timeline[bucketIndex];

      if (event.type === "provider_success") {
        summary.attempts += 1;
        summary.successes += 1;
        provider.attempts += 1;
        provider.successes += 1;
        bucket.successes += 1;
      } else if (event.type === "provider_failure") {
        summary.attempts += 1;
        summary.failures += 1;
        provider.attempts += 1;
        provider.failures += 1;
        provider.lastFailureAt = event.timestamp;
        bucket.failures += 1;
      } else if (event.type === "recovery_attempt_started") {
        summary.recoveryAttempts += 1;
        provider.recoveryAttempts += 1;
        bucket.recoveryAttempts += 1;
      }

      if (event.transition === "opened" || event.transition === "reopened") {
        summary.circuitOpenings += 1;
        provider.circuitOpenings += 1;
        bucket.circuitOpenings += 1;
      }
      if (event.transition === "recovered") {
        summary.recoveries += 1;
        provider.recoveries += 1;
        bucket.recoveries += 1;
        if (Number.isFinite(event.recoveryDurationMs) && event.recoveryDurationMs >= 0) {
          recoveryDurations.push(event.recoveryDurationMs);
        }
      }
      providerMap.set(event.targetId, provider);
    }

    if (summary.attempts > 0) {
      summary.failureRate = summary.failures / summary.attempts;
      summary.successRate = summary.successes / summary.attempts;
    }
    if (recoveryDurations.length) {
      summary.averageRecoveryDurationMs = recoveryDurations.reduce((total, value) => total + value, 0) /
        recoveryDurations.length;
    }

    const providers = [...providerMap.values()].map(provider => {
      if (provider.attempts > 0) provider.failureRate = provider.failures / provider.attempts;
      const durations = events
        .filter(event => event.targetId === provider.targetId && event.transition === "recovered" &&
          Number.isFinite(event.recoveryDurationMs) && event.recoveryDurationMs >= 0)
        .map(event => event.recoveryDurationMs);
      if (durations.length) {
        provider.averageRecoveryDurationMs = durations.reduce((total, value) => total + value, 0) /
          durations.length;
      }
      return provider;
    }).sort((left, right) =>
      right.failures - left.failures || left.targetId.localeCompare(right.targetId)
    );

    return {
      available: true,
      windowMs,
      from,
      to: now,
      retentionMs: historyRetentionMs,
      maxEntries: historyMaxEntries,
      retainedEventCount: retainedEvents.length,
      droppedEventCount: current?.droppedEventCount || 0,
      truncated: (current?.droppedEventCount || 0) > 0,
      historyWriteFailures,
      summary,
      providers,
      timeline,
      recentEvents: events.slice(-limit).reverse().map(event => ({ ...event }))
    };
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
    history,
    config: {
      failureThreshold,
      failureWindowMs,
      cooldownMs,
      probeLeaseMs,
      historyRetentionMs,
      historyMaxEntries,
      namespace
    }
  };
}

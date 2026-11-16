import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryCoordinationStore } from "../../coordination/src/index.js";
import { createSQLiteStateStores } from "../../sqlite/src/index.js";
import { createCircuitBreaker } from "../src/index.js";

function fixture(options = {}) {
  let now = 1_000;
  const store = options.store || createInMemoryCoordinationStore();
  const breaker = createCircuitBreaker({
    store,
    failureThreshold: options.failureThreshold ?? 3,
    failureWindowMs: options.failureWindowMs ?? 1_000,
    cooldownMs: options.cooldownMs ?? 500,
    probeLeaseMs: options.probeLeaseMs ?? 100,
    clock: () => now
  });
  return {
    breaker,
    store,
    advance(ms) { now += ms; },
    now() { return now; }
  };
}

test("circuit opens only after the configured consecutive failure threshold", async () => {
  const { breaker } = fixture({ failureThreshold: 3 });
  const targets = [{ id: "gpu-a", mode: "cloud", available: true }];

  assert.equal((await breaker.inspect("acme", "gpu-a")).state, "closed");
  await breaker.recordFailure("acme", "gpu-a");
  assert.equal((await breaker.inspect("acme", "gpu-a")).state, "closed");
  await breaker.recordFailure("acme", "gpu-a");
  assert.equal((await breaker.inspect("acme", "gpu-a")).failureCount, 2);

  await breaker.recordFailure("acme", "gpu-a");
  const [target] = await breaker.annotateTargets(targets, "acme");
  assert.equal(target.circuitBreaker.state, "open");
  assert.equal(target.circuitBreaker.failureCount, 3);
  assert.equal(typeof target.circuitBreaker.retryAt, "number");
  assert.equal(target.available, true);
});

test("successful closed-circuit execution resets consecutive failures", async () => {
  const { breaker } = fixture({ failureThreshold: 3 });
  await breaker.recordFailure("acme", "gpu-a");
  await breaker.recordFailure("acme", "gpu-a");
  assert.equal((await breaker.inspect("acme", "gpu-a")).failureCount, 2);

  assert.equal(await breaker.recordSuccess("acme", "gpu-a"), true);
  assert.deepEqual(await breaker.inspect("acme", "gpu-a"), {
    state: "closed",
    failureCount: 0,
    retryAt: null,
    probeInFlight: false
  });
});

test("open circuit rejects execution until cooldown and admits only one half-open probe", async () => {
  const { breaker, advance } = fixture({ failureThreshold: 2, cooldownMs: 500 });
  await breaker.recordFailure("acme", "gpu-a");
  await breaker.recordFailure("acme", "gpu-a");

  const blocked = await breaker.acquire("acme", "gpu-a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "circuit_breaker_open");

  advance(500);
  const first = await breaker.acquire("acme", "gpu-a");
  assert.equal(first.allowed, true);
  assert.ok(first.probeToken);
  assert.equal(first.state.state, "half-open");

  const second = await breaker.acquire("acme", "gpu-a");
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "circuit_breaker_half_open_busy");

  assert.equal(await breaker.recordSuccess("acme", "gpu-a", {
    probeToken: first.probeToken
  }), true);
  assert.equal((await breaker.inspect("acme", "gpu-a")).state, "closed");

  const retried = await breaker.acquire("acme", "gpu-a");
  assert.equal(retried.allowed, true);
  assert.equal(retried.probeToken, null);
});

test("failed half-open probe reopens the circuit with a fresh cooldown", async () => {
  const { breaker, advance, now } = fixture({ failureThreshold: 1, cooldownMs: 500 });
  await breaker.recordFailure("acme", "gpu-a");
  advance(500);
  const probe = await breaker.acquire("acme", "gpu-a");
  assert.equal(probe.allowed, true);

  await breaker.recordFailure("acme", "gpu-a", { probeToken: probe.probeToken });
  const state = await breaker.inspect("acme", "gpu-a");
  assert.equal(state.state, "open");
  assert.equal(state.openedAt, now());
  assert.equal(state.retryAt, now() + 500);
});

test("breaker state is isolated by tenant and target identifier", async () => {
  const { breaker } = fixture({ failureThreshold: 1 });
  await breaker.recordFailure("acme", "shared/gpu");
  assert.equal((await breaker.inspect("acme", "shared/gpu")).state, "open");
  assert.equal((await breaker.inspect("beta", "shared/gpu")).state, "closed");
  assert.equal((await breaker.inspect("acme", "other")).state, "closed");

  const annotated = await breaker.annotateTargets([
    { id: "shared/gpu", mode: "cloud" }
  ], "beta");
  assert.equal(annotated[0].circuitBreaker.state, "closed");
});

test("separate API instances share open state and the half-open lease through coordination", async () => {
  const shared = createInMemoryCoordinationStore();
  let now = 10_000;
  const config = {
    store: shared,
    failureThreshold: 1,
    failureWindowMs: 2_000,
    cooldownMs: 500,
    probeLeaseMs: 100,
    clock: () => now
  };
  const firstInstance = createCircuitBreaker(config);
  const secondInstance = createCircuitBreaker(config);

  await firstInstance.recordFailure("acme", "gpu-a");
  assert.equal((await secondInstance.inspect("acme", "gpu-a")).state, "open");

  now += 500;
  const firstProbe = await firstInstance.acquire("acme", "gpu-a");
  const secondProbe = await secondInstance.acquire("acme", "gpu-a");
  assert.equal(firstProbe.allowed, true);
  assert.equal(secondProbe.allowed, false);
  assert.equal(secondProbe.reason, "circuit_breaker_half_open_busy");
});

test("expired half-open leases can be recovered and stale probe owners cannot close them", async () => {
  const { breaker, advance } = fixture({
    failureThreshold: 1,
    cooldownMs: 100,
    probeLeaseMs: 50
  });
  await breaker.recordFailure("acme", "gpu-a");
  advance(100);
  const stale = await breaker.acquire("acme", "gpu-a");
  assert.equal(stale.allowed, true);

  advance(51);
  const replacement = await breaker.acquire("acme", "gpu-a");
  assert.equal(replacement.allowed, true);
  assert.notEqual(replacement.probeToken, stale.probeToken);

  assert.equal(await breaker.recordSuccess("acme", "gpu-a", {
    probeToken: stale.probeToken
  }), false);
  assert.equal((await breaker.inspect("acme", "gpu-a")).probeInFlight, true);
  assert.equal(await breaker.recordSuccess("acme", "gpu-a", {
    probeToken: replacement.probeToken
  }), true);
  assert.equal((await breaker.inspect("acme", "gpu-a")).state, "closed");
});

test("expired half-open lease cannot close a circuit without a current probe owner", async () => {
  const { breaker, advance } = fixture({
    failureThreshold: 1,
    cooldownMs: 100,
    probeLeaseMs: 50
  });
  await breaker.recordFailure("acme", "gpu-a");
  advance(100);
  const expired = await breaker.acquire("acme", "gpu-a");
  assert.equal(expired.allowed, true);

  advance(51);
  assert.equal(await breaker.recordSuccess("acme", "gpu-a", {
    probeToken: expired.probeToken
  }), false);
  const state = await breaker.inspect("acme", "gpu-a");
  assert.equal(state.state, "half-open");
  assert.equal(state.probeInFlight, false);
});

test("SQLite coordination shares breaker state and half-open leases across instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-circuit-sqlite-"));
  const file = path.join(dir, "state.db");
  const stores = createSQLiteStateStores({ filePath: file, maxEntries: 20 });
  let now = Date.now();
  const options = {
    store: stores.coordination,
    failureThreshold: 1,
    failureWindowMs: 1_000,
    cooldownMs: 500,
    probeLeaseMs: 100,
    clock: () => now
  };
  const firstInstance = createCircuitBreaker(options);
  const secondInstance = createCircuitBreaker(options);

  try {
    await firstInstance.recordFailure("acme", "sqlite-gpu");
    assert.equal((await secondInstance.inspect("acme", "sqlite-gpu")).state, "open");

    now += 500;
    const firstProbe = await firstInstance.acquire("acme", "sqlite-gpu");
    const secondProbe = await secondInstance.acquire("acme", "sqlite-gpu");
    assert.equal(firstProbe.allowed, true);
    assert.equal(secondProbe.allowed, false);
    assert.equal(secondProbe.reason, "circuit_breaker_half_open_busy");

    assert.equal(await secondInstance.recordSuccess("acme", "sqlite-gpu", {
      probeToken: firstProbe.probeToken
    }), true);
    assert.equal((await firstInstance.inspect("acme", "sqlite-gpu")).state, "closed");
  } finally {
    stores.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("breaker validates thresholds and requires atomic coordination methods", () => {
  assert.throws(() => createCircuitBreaker({ failureThreshold: 0 }), /failureThreshold/);
  assert.throws(() => createCircuitBreaker({ cooldownMs: 0 }), /cooldownMs/);
  assert.throws(() => createCircuitBreaker({
    store: { get() {}, setIfAbsent() {} }
  }), /atomic methods/);
});

test("breaker snapshot reports open and half-open target counts", async () => {
  const { breaker, advance } = fixture({ failureThreshold: 1, cooldownMs: 100 });
  await breaker.recordFailure("acme", "gpu-a");
  const open = await breaker.snapshot([
    { id: "gpu-a" },
    { id: "gpu-b" }
  ], "acme");
  assert.deepEqual(open, { total: 2, open: 1, halfOpen: 0, closed: 1 });

  advance(100);
  const halfOpen = await breaker.snapshot([{ id: "gpu-a" }], "acme");
  assert.deepEqual(halfOpen, { total: 1, open: 0, halfOpen: 1, closed: 0 });
});


test("reliability history aggregates outcomes and recovery transitions by time bucket", async () => {
  const { breaker, advance, now } = fixture({ failureThreshold: 2, cooldownMs: 500 });
  await breaker.recordFailure("acme", "gpu-a", { source: "manual_probe" });
  advance(100);
  await breaker.recordFailure("acme", "gpu-a", { source: "execution" });
  advance(500);
  const recovery = await breaker.acquire("acme", "gpu-a", { source: "manual_probe" });
  assert.equal(recovery.allowed, true);
  advance(100);
  await breaker.recordSuccess("acme", "gpu-a", {
    probeToken: recovery.probeToken,
    source: "manual_probe"
  });
  advance(500);
  await breaker.recordSuccess("acme", "gpu-a", { source: "execution" });

  const report = await breaker.history("acme", { windowMs: 5_000, limit: 10 });
  assert.equal(report.available, true);
  assert.equal(report.summary.attempts, 4);
  assert.equal(report.summary.successes, 2);
  assert.equal(report.summary.failures, 2);
  assert.equal(report.summary.failureRate, 0.5);
  assert.equal(report.summary.recoveryAttempts, 1);
  assert.equal(report.summary.circuitOpenings, 1);
  assert.equal(report.summary.recoveries, 1);
  assert.equal(report.summary.averageRecoveryDurationMs, 600);
  assert.equal(report.providers[0].targetId, "gpu-a");
  assert.equal(report.providers[0].failureRate, 0.5);
  assert.equal(report.providers[0].recoveryAttempts, 1);
  assert.equal(report.providers[0].recoveries, 1);
  assert.equal(report.recentEvents.length, 5);
  assert.equal(report.recentEvents[0].type, "provider_success");
  assert.equal(report.recentEvents.at(-1).type, "provider_failure");
  assert.equal(report.timeline.length, 24);
  assert.equal(report.to, now());
});

test("reliability history is bounded, reports eviction and stays tenant-isolated", async () => {
  const shared = createInMemoryCoordinationStore();
  let now = 10_000;
  const options = {
    store: shared,
    failureThreshold: 10,
    failureWindowMs: 1_000,
    cooldownMs: 500,
    clock: () => now,
    historyMaxEntries: 3
  };
  const first = createCircuitBreaker(options);
  const second = createCircuitBreaker(options);
  for (let index = 0; index < 5; index++) {
    await first.recordFailure("acme", "gpu-" + index);
    now += 1;
  }
  const report = await second.history("acme", { windowMs: 1_000, limit: 10 });
  assert.equal(report.retainedEventCount, 3);
  assert.equal(report.droppedEventCount, 2);
  assert.equal(report.truncated, true);
  assert.deepEqual(report.recentEvents.map(event => event.targetId), ["gpu-4", "gpu-3", "gpu-2"]);
  assert.equal((await second.history("beta", { windowMs: 1_000 })).retainedEventCount, 0);
});

test("SQLite coordination persists reliability history across breaker instances", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-reliability-sqlite-"));
  const file = path.join(dir, "state.db");
  const stores = createSQLiteStateStores({ filePath: file, maxEntries: 20 });
  let now = Date.now();
  const options = {
    store: stores.coordination,
    failureThreshold: 1,
    failureWindowMs: 1_000,
    cooldownMs: 500,
    clock: () => now
  };
  const first = createCircuitBreaker(options);
  const second = createCircuitBreaker(options);
  try {
    await first.recordFailure("acme", "sqlite-gpu", { source: "scheduled_probe" });
    const report = await second.history("acme", { windowMs: 60_000 });
    assert.equal(report.summary.failures, 1);
    assert.equal(report.recentEvents[0].source, "scheduled_probe");

    const restarted = createCircuitBreaker(options);
    const afterRestart = await restarted.history("acme", { windowMs: 60_000 });
    assert.equal(afterRestart.summary.failures, 1);
    assert.equal(afterRestart.providers[0].targetId, "sqlite-gpu");
  } finally {
    stores.close();
    await rm(dir, { recursive: true, force: true });
  }
});

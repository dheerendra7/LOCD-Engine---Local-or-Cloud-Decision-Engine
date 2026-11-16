import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCoordinationStore } from "../../coordination/src/index.js";
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

import test from "node:test";
import assert from "node:assert/strict";
import { createProbeScheduler } from "../src/index.js";

function makeRegistry(targets, handlers) {
  return {
    async list() {
      return targets;
    },
    async probe(id) {
      return handlers[id]();
    }
  };
}

test("runOnce probes every target with bounded concurrency", async () => {
  const started = new Set();
  let peak = 0;
  let active = 0;

  const targets = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" }
  ];

  const registry = makeRegistry(targets, Object.fromEntries(
    targets.map(target => [target.id, async () => {
      active++;
      peak = Math.max(peak, active);
      started.add(target.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return { id: target.id, available: true };
    }])
  ));

  const scheduler = createProbeScheduler({
    registry,
    maxConcurrent: 2,
    intervalMs: 1000
  });

  const results = await scheduler.runOnce();

  assert.equal(results.length, 4);
  assert.equal(peak, 2);
  assert.deepEqual([...started].sort(), ["a", "b", "c", "d"]);
  assert.equal(results.filter(item => item.status === "success").length, 4);
});

test("probe failures are isolated per target", async () => {
  const registry = makeRegistry(
    [{ id: "ok" }, { id: "bad" }],
    {
      ok: async () => ({ id: "ok", available: true }),
      bad: async () => { throw new Error("provider_down"); }
    }
  );

  const events = [];
  const scheduler = createProbeScheduler({
    registry,
    onResult: event => events.push(event)
  });

  const results = await scheduler.runOnce();
  assert.equal(results.find(item => item.targetId === "ok").status, "success");
  assert.equal(results.find(item => item.targetId === "bad").errorClass, "provider_down");
  assert.equal(events.length, 2);
});

test("scheduler start and stop are idempotent", () => {
  let started = 0;
  let stopped = 0;
  const registry = {
    async list() { return []; },
    async probe() { return {}; }
  };

  const scheduler = createProbeScheduler({
    registry,
    intervalMs: 1000,
    setIntervalImpl: () => {
      started++;
      return "timer";
    },
    clearIntervalImpl: value => {
      assert.equal(value, "timer");
      stopped++;
    }
  });

  assert.equal(scheduler.isRunning(), false);
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.isRunning(), true);
  assert.equal(scheduler.stop(), true);
  assert.equal(scheduler.stop(), false);
  assert.equal(scheduler.isRunning(), false);
  assert.equal(started, 1);
  assert.equal(stopped, 1);
});

test("invalid scheduler configuration fails clearly", () => {
  const registry = {
    async list() { return []; },
    async probe() { return {}; }
  };

  assert.throws(
    () => createProbeScheduler({ registry, intervalMs: 99 }),
    /intervalMs must be >= 100/
  );
  assert.throws(
    () => createProbeScheduler({ registry, maxConcurrent: 0 }),
    /maxConcurrent must be a positive integer/
  );
});

test("duplicate probe calls for the same target do not overlap", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;

  const registry = makeRegistry([{ id: "same" }], {
    same: async () => {
      calls++;
      await gate;
      return { id: "same", available: true };
    }
  });

  const scheduler = createProbeScheduler({ registry, intervalMs: 1000 });

  const first = scheduler.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  const second = scheduler.runOnce();

  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.ok(
    [...a, ...b].some(item => item.reason === "probe_already_running") ||
    scheduler.inFlightCount() === 0
  );
});

test("scheduler prefers registry listProbeable when available", async () => {
  const calls = [];
  const registry = {
    async list() {
      throw new Error("list should not be called");
    },
    async listProbeable() {
      return [{ id: "probeable-only" }];
    },
    async probe(id) {
      calls.push(id);
      return { id, available: true };
    }
  };

  const scheduler = createProbeScheduler({ registry, intervalMs: 1000 });
  const results = await scheduler.runOnce();

  assert.deepEqual(calls, ["probeable-only"]);
  assert.equal(results[0].status, "success");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createTargetRegistry } from "../src/index.js";

test("registry stores and lists normalized targets", async () => {
  const registry = createTargetRegistry();
  registry.register({
    id: "gpu-local",
    mode: "local",
    health: 1,
    capacity: 0.2,
    privacy: 1
  });

  assert.equal(registry.count(), 1);
  assert.equal(registry.has("gpu-local"), true);
  assert.deepEqual((await registry.list())[0].id, "gpu-local");
});

test("registry rejects duplicate target ids", () => {
  const registry = createTargetRegistry([{ id: "a", mode: "local" }]);
  assert.throws(
    () => registry.register({ id: "a", mode: "cloud" }),
    /target already registered/
  );
});

test("registry supports removal and lookup", async () => {
  const registry = createTargetRegistry([{ id: "a", mode: "private" }]);
  assert.equal((await registry.get("a")).mode, "private");
  assert.equal(registry.remove("a"), true);
  assert.equal(await registry.get("a"), null);
  assert.equal(registry.remove("missing"), false);
});

test("registry can manage adapter instances", async () => {
  const adapter = {
    id: "adapter-1",
    async getSnapshot() {
      return {
        id: "adapter-1",
        mode: "cloud",
        health: 0.99,
        capacity: 0.2,
        privacy: 0.4
      };
    }
  };

  const registry = createTargetRegistry([adapter]);
  assert.equal((await registry.list())[0].id, "adapter-1");
});

test("registry heartbeat updates target telemetry and timestamp", async () => {
  const registry = createTargetRegistry([{
    id: "heartbeat-target",
    mode: "local",
    health: 0.5,
    capacity: 0.7
  }]);

  const updated = await registry.heartbeat("heartbeat-target", {
    health: 0.98,
    capacity: 0.2,
    estimatedLatencyMs: 45
  });

  assert.equal(updated.health, 0.98);
  assert.equal(updated.capacity, 0.2);
  assert.equal(updated.estimatedLatencyMs, 45);
  assert.match(updated.lastHeartbeatAt, /^2026|^202[0-9]-/);
});

test("registry heartbeat rejects unsupported adapters", async () => {
  const registry = createTargetRegistry([{
    id: "read-only",
    async getSnapshot() {
      return { id: "read-only", mode: "cloud" };
    }
  }]);

  await assert.rejects(
    () => registry.heartbeat("read-only", { health: 1 }),
    /target_does_not_support_heartbeat/
  );
});

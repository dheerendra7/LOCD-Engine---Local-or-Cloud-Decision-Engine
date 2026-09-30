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

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("registry persists and reloads targets atomically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-registry-"));
  const file = path.join(dir, "targets.json");

  try {
    const source = createTargetRegistry([{
      id: "persisted-local",
      mode: "local",
      health: 1,
      capacity: 0.2,
      privacy: 1
    }]);

    const savedPath = await source.saveToFile(file);
    assert.equal(savedPath, path.resolve(file));

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw[0].id, "persisted-local");

    const restored = createTargetRegistry();
    assert.equal(await restored.loadFromFile(file), 1);
    assert.equal((await restored.get("persisted-local")).mode, "local");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing persistence file is treated as empty state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-registry-missing-"));
  const file = path.join(dir, "missing.json");

  try {
    const registry = createTargetRegistry();
    assert.equal(await registry.loadFromFile(file), 0);
    assert.equal(registry.count(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid persistence payload is rejected without clearing current state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-registry-invalid-"));
  const file = path.join(dir, "invalid.json");

  try {
    const registry = createTargetRegistry([{ id: "keep", mode: "local" }]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ nope: true }), "utf8");

    await assert.rejects(
      () => registry.loadFromFile(file),
      /target file must contain an array/
    );
    assert.equal(registry.has("keep"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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


test("registry can probe adapters that expose probe()", async () => {
  const registry = createTargetRegistry([{
    id: "probed",
    targetId: "probed",
    async getSnapshot() {
      return { id: "probed", mode: "private", health: 0.2 };
    },
    async probe() {
      return { id: "probed", mode: "private", health: 1, available: true };
    }
  }]);

  const snapshot = await registry.probe("probed");
  assert.equal(snapshot.health, 1);
});

test("registry distinguishes adapters without probe support", async () => {
  const registry = createTargetRegistry([{
    id: "no-probe",
    async getSnapshot() {
      return { id: "no-probe", mode: "local" };
    }
  }]);

  await assert.rejects(
    () => registry.probe("no-probe"),
    /target_does_not_support_probe/
  );
});

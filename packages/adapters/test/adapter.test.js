import test from "node:test";
import assert from "node:assert/strict";
import {
  collectTargetSnapshots,
  createStaticTargetAdapter
} from "../src/index.js";

test("static adapter returns normalized snapshots", async () => {
  const adapter = createStaticTargetAdapter({
    id: "local-gpu",
    mode: "local",
    health: "0.9",
    capacity: 0.2,
    privacy: 1,
    estimatedLatencyMs: "120",
    estimatedCostUsd: 0,
    regions: ["local", "local"],
    capabilities: ["text-generation", "text-generation"]
  });

  assert.deepEqual(await adapter.getSnapshot(), {
    id: "local-gpu",
    mode: "local",
    available: true,
    health: 0.9,
    capacity: 0.2,
    privacy: 1,
    estimatedLatencyMs: 120,
    estimatedCostUsd: 0,
    pricing: null,
    availableMemoryGb: null,
    maxContextTokens: null,
    lastHeartbeatAt: null,
    regions: ["local"],
    capabilities: ["text-generation"]
  });
});

test("adapter ids are stable", async () => {
  const adapter = createStaticTargetAdapter({
    id: "private-1",
    mode: "private"
  });

  await assert.rejects(
    () => adapter.setSnapshot({ id: "private-2", mode: "private" }),
    /adapter id cannot change/
  );
});

test("invalid adapter snapshots fail early", () => {
  assert.throws(
    () => createStaticTargetAdapter({ id: "x", mode: "satellite" }),
    /adapter mode must be one of/
  );
  assert.throws(
    () => createStaticTargetAdapter({ mode: "local" }),
    /adapter snapshot id is required/
  );
});

test("snapshot collection validates interface and duplicate ids", async () => {
  const a = createStaticTargetAdapter({ id: "a", mode: "local" });
  const b = createStaticTargetAdapter({ id: "b", mode: "cloud" });
  const snapshots = await collectTargetSnapshots([a, b]);
  assert.equal(snapshots.length, 2);

  await assert.rejects(
    () => collectTargetSnapshots([{ id: "broken" }]),
    /each adapter must implement getSnapshot/
  );

  await assert.rejects(
    () => collectTargetSnapshots([a, a]),
    /adapter ids must be unique/
  );
});

test("snapshot collection allows an empty target set", async () => {
  assert.deepEqual(await collectTargetSnapshots([]), []);
});

test("capacity telemetry is normalized by adapters", async () => {
  const adapter = createStaticTargetAdapter({
    id: "gpu",
    mode: "local",
    availableMemoryGb: "24",
    maxContextTokens: "64000"
  });
  assert.equal((await adapter.getSnapshot()).availableMemoryGb, 24);
  assert.equal((await adapter.getSnapshot()).maxContextTokens, 64000);
});

test("partial heartbeat updates preserve existing target fields", async () => {
  const adapter = createStaticTargetAdapter({
    id: "heartbeat-gpu",
    mode: "local",
    health: 0.8,
    capacity: 0.5,
    privacy: 1,
    estimatedLatencyMs: 200,
    estimatedCostUsd: 0,
    regions: ["local"]
  });

  const updated = await adapter.setSnapshot({
    health: 0.99,
    capacity: 0.1,
    lastHeartbeatAt: "2026-09-30T00:00:00Z"
  });

  assert.equal(updated.id, "heartbeat-gpu");
  assert.equal(updated.mode, "local");
  assert.equal(updated.estimatedLatencyMs, 200);
  assert.equal(updated.health, 0.99);
  assert.equal(updated.capacity, 0.1);
  assert.equal(updated.lastHeartbeatAt, "2026-09-30T00:00:00.000Z");
});

test("target pricing metadata is normalized and preserved", async () => {
  const adapter = createStaticTargetAdapter({
    id: "priced-target",
    mode: "cloud",
    pricing: {
      unit: "per-1k-tokens",
      currency: "USD",
      inputUsdPer1kTokens: 0.002,
      outputUsdPer1kTokens: 0.004
    }
  });

  const snapshot = await adapter.getSnapshot();
  assert.deepEqual(snapshot.pricing, {
    unit: "per-1k-tokens",
    currency: "USD",
    inputUsdPer1kTokens: 0.002,
    outputUsdPer1kTokens: 0.004
  });
});


test("unknown optional telemetry remains null through adapters and registry snapshot collection", async () => {
  const adapter = createStaticTargetAdapter({
    id: "unpriced-cloud",
    mode: "cloud",
    estimatedLatencyMs: null,
    estimatedCostUsd: null,
    availableMemoryGb: null,
    maxContextTokens: null,
    pricing: {
      unit: "per-1k-tokens",
      currency: "USD",
      inputUsdPer1kTokens: 0.003,
      outputUsdPer1kTokens: 0.012
    }
  });

  const direct = await adapter.getSnapshot();
  assert.equal(direct.estimatedLatencyMs, null);
  assert.equal(direct.estimatedCostUsd, null);
  assert.equal(direct.availableMemoryGb, null);
  assert.equal(direct.maxContextTokens, null);

  const [collected] = await collectTargetSnapshots([adapter]);
  assert.equal(collected.estimatedLatencyMs, null);
  assert.equal(collected.estimatedCostUsd, null);
  assert.equal(collected.availableMemoryGb, null);
  assert.equal(collected.maxContextTokens, null);
  assert.equal(collected.pricing.inputUsdPer1kTokens, 0.003);
});


test("blank optional telemetry stays unknown in static target adapters", async () => {
  const adapter = createStaticTargetAdapter({
    id: "blank-metrics",
    mode: "cloud",
    estimatedLatencyMs: " ",
    estimatedCostUsd: " ",
    availableMemoryGb: " ",
    maxContextTokens: " "
  });
  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
});


test("negative optional telemetry stays unknown and negative capacity gets a safe fallback", async () => {
  const adapter = createStaticTargetAdapter({
    id: "negative-telemetry",
    mode: "cloud",
    health: -1,
    capacity: -1,
    privacy: -1,
    estimatedLatencyMs: -10,
    estimatedCostUsd: -0.1,
    availableMemoryGb: -2,
    maxContextTokens: -100
  });

  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.health, 0);
  assert.equal(snapshot.capacity, 1);
  assert.equal(snapshot.privacy, 0);
  assert.equal(snapshot.estimatedLatencyMs, null);
  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.availableMemoryGb, null);
  assert.equal(snapshot.maxContextTokens, null);
});

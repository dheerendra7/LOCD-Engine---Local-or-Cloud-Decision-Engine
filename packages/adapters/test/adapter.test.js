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
    availableMemoryGb: null,
    maxContextTokens: null,
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

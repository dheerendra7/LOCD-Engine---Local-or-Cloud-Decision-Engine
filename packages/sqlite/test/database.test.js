import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSQLiteCoordinationStore,
  createSQLiteDecisionStore,
  createSQLiteStateStores
} from "../src/index.js";

test("sqlite telemetry survives store recreation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-telemetry-"));
  const file = path.join(dir, "state.db");

  try {
    const first = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    first.record({ id: "sqlite-1", route: "local", workloadType: "classification" });
    first.close();

    const second = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    assert.deepEqual(second.list({ limit: 10 }).map(event => event.id), ["sqlite-1"]);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite telemetry records outcomes and summaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-outcome-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteDecisionStore({ filePath: file, maxEntries: 10 });
    store.record({
      id: "sqlite-outcome",
      route: "cloud",
      workloadType: "llm",
      estimatedLatencyMs: 100,
      estimatedCostUsd: 0.01
    });

    const updated = store.recordOutcome("sqlite-outcome", {
      outcome: "success",
      actualLatencyMs: 125,
      actualCostUsd: 0.012
    });

    assert.equal(updated.outcome, "success");
    assert.equal(store.summary().meanAbsoluteLatencyErrorMs, 25);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite telemetry is bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-bound-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteDecisionStore({ filePath: file, maxEntries: 2 });
    for (const id of ["1", "2", "3"]) {
      store.record({ id, route: "local", workloadType: "batch" });
    }
    assert.deepEqual(store.list({ limit: 10 }).map(event => event.id), ["3", "2"]);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite coordination is shared across separate connections", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-coord-"));
  const file = path.join(dir, "state.db");

  try {
    const one = createSQLiteCoordinationStore({ filePath: file });
    const two = createSQLiteCoordinationStore({ filePath: file });

    assert.equal(await one.setIfAbsent("lock", { owner: "one" }), true);
    assert.equal(await two.setIfAbsent("lock", { owner: "two" }), false);
    assert.deepEqual(await two.get("lock"), { owner: "one" });

    assert.equal(await one.incr("counter", { ttlMs: 1000 }), 1);
    assert.equal(await two.incr("counter", { ttlMs: 1000 }), 2);

    one.close();
    two.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite coordination expires state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-expiry-"));
  const file = path.join(dir, "state.db");

  try {
    const store = createSQLiteCoordinationStore({ filePath: file });
    await store.set("key", { value: 1 }, { ttlMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await store.get("key"), null);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite state factory shares telemetry and coordination on one database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-sqlite-state-"));
  const file = path.join(dir, "state.db");

  try {
    const stores = createSQLiteStateStores({ filePath: file });
    stores.telemetry.record({ id: "state-1", route: "local", workloadType: "batch" });
    await stores.coordination.set("shared", { ok: true });

    assert.equal(stores.telemetry.list({ limit: 1 })[0].id, "state-1");
    assert.deepEqual(await stores.coordination.get("shared"), { ok: true });
    stores.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

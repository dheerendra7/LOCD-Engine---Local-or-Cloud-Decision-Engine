test("policy stores expose persistence capabilities", async () => {
  const memory = createPolicyStore();
  assert.deepEqual(memory.capabilities, {
    durable: false,
    shared: false,
    tenantScoped: true,
    transactional: false
  });

  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-policy-capabilities-"));
  try {
    const file = await createFilePolicyStore({
      filePath: path.join(dir, "policies.json")
    });
    assert.deepEqual(file.capabilities, {
      durable: true,
      shared: false,
      tenantScoped: true,
      transactional: false
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFilePolicyStore, createPolicyStore } from "../src/index.js";
import { createPersistenceQueue } from "../src/store.js";

const policy = {
  id: "acme-fast",
  name: "Acme Fast",
  description: "Latency-first policy for Acme.",
  baseProfile: "balanced",
  weights: {
    privacy: 0.2,
    latency: 0.5,
    cost: 0.1,
    capacity: 0.1,
    reliability: 0.1
  },
  rules: [
    {
      id: "prefer-local-llm",
      priority: 10,
      when: { workloadType: "llm-inference" },
      set: { sensitiveDataMode: "prefer-local" }
    }
  ]
};

test("policy update metadata is generated once per version", () => {
  let nowCalls = 0;
  const store = createPolicyStore({
    now: () => "2026-10-08T00:00:0" + (++nowCalls) + ".000Z"
  });

  const saved = store.upsert("acme", policy, { updatedBy: "admin" });

  assert.equal(nowCalls, 1);
  assert.equal(saved.updatedAt, "2026-10-08T00:00:01.000Z");
  assert.equal(saved.versions[0].updatedAt, saved.updatedAt);
});

test("persistence queue serializes overlapping writes", async () => {
  const events = [];
  let releaseFirst;
  const firstBlocked = new Promise(resolve => {
    releaseFirst = resolve;
  });

  const persist = createPersistenceQueue(async snapshot => {
    events.push("start:" + snapshot.version);
    if (snapshot.version === 1) await firstBlocked;
    events.push("done:" + snapshot.version);
  });

  const first = persist({ version: 1 });
  const second = persist({ version: 2 });

  await Promise.resolve();
  assert.deepEqual(events, ["start:1"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "start:1",
    "done:1",
    "start:2",
    "done:2"
  ]);
});

test("policy versions increment and history is bounded", () => {
  const store = createPolicyStore({ maxVersionsPerPolicy: 2, now: () => "2026-10-08T00:00:00.000Z" });
  const first = store.upsert("acme", policy, { updatedBy: "admin" });
  const second = store.upsert("acme", { ...policy, description: "v2" }, { updatedBy: "operator" });
  const third = store.upsert("acme", { ...policy, description: "v3" }, { updatedBy: "operator" });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(third.version, 3);
  assert.equal(store.get("acme", "acme-fast").version, 3);
  assert.equal(store.history("acme", "acme-fast").versions.length, 2);
});

test("policy store rollback creates a new version from history", () => {
  const store = createPolicyStore({
    now: (() => {
      let i = 0;
      return () => "2026-10-08T00:00:0" + (++i) + ".000Z";
    })()
  });

  const first = store.upsert("acme", { ...policy, description: "v1" });
  store.upsert("acme", { ...policy, description: "v2" });

  const restored = store.rollback("acme", "acme-fast", first.version, { updatedBy: "rollback" });

  assert.equal(restored.version, 3);
  assert.equal(restored.rolledBackFromVersion, 1);
  assert.equal(restored.policy.description, "v1");
  assert.equal(store.history("acme", "acme-fast").versions.at(-1).version, 3);
});

test("policy store rollback returns null for missing version", () => {
  const store = createPolicyStore();
  store.upsert("acme", policy);
  assert.equal(store.rollback("acme", "acme-fast", 99), null);
});

test("tenant policies are isolated", () => {
  const store = createPolicyStore();
  store.upsert("acme", policy);
  store.upsert("beta", { ...policy, description: "beta policy" });

  assert.equal(store.get("acme", "acme-fast").tenantId, "acme");
  assert.equal(store.get("beta", "acme-fast").tenantId, "beta");
  assert.equal(store.list("acme").length, 1);
  assert.equal(store.list("beta").length, 1);
});

test("built-in policy IDs are read-only", () => {
  const store = createPolicyStore();
  assert.throws(
    () => store.upsert("acme", { ...policy, id: "balanced" }),
    /built-in policy IDs are read-only/
  );
});

test("invalid policies are rejected before persistence", () => {
  const store = createPolicyStore();
  assert.throws(
    () => store.upsert("acme", { ...policy, baseProfile: "missing" }),
    /unknown policy profile/
  );
  assert.throws(
    () => store.upsert("acme", {
      ...policy,
      rules: [{ id: "bad", priority: 1, set: { unsupported: true } }]
    }),
    /policy rule field is not supported/
  );
});

test("file policy store persists atomically and restores versions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-policy-store-"));
  const file = path.join(dir, "policies.json");

  try {
    const store = await createFilePolicyStore({ filePath: file });
    await store.upsert("acme", policy, { updatedBy: "admin" });
    await store.upsert("acme", { ...policy, description: "v2" }, { updatedBy: "admin" });

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.tenants.acme.policies["acme-fast"].version, 2);

    const restored = await createFilePolicyStore({ filePath: file });
    assert.equal(restored.get("acme", "acme-fast").version, 2);
    assert.equal(restored.history("acme", "acme-fast").versions.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

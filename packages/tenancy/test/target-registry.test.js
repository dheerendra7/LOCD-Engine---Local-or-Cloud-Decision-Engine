import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTenantTargetRegistry } from "../src/target-registry.js";

const target = id => ({
  id,
  mode: "local",
  available: true,
  health: 1,
  capacity: 0.2,
  privacy: 1,
  estimatedLatencyMs: 20,
  estimatedCostUsd: 0
});

test("tenant registries isolate same target IDs", async () => {
  const registry = createTenantTargetRegistry();
  registry.forTenant("acme").register(target("gpu"));
  registry.forTenant("beta").register(target("gpu"));

  assert.deepEqual((await registry.forTenant("acme").list()).map(item => item.id), ["gpu"]);
  assert.deepEqual((await registry.forTenant("beta").list()).map(item => item.id), ["gpu"]);
  assert.equal(registry.forTenant("acme").has("gpu"), true);
  assert.equal(registry.forTenant("beta").has("gpu"), true);
  assert.equal(registry.listTenantIds().join(","), "acme,beta");
});

test("tenant target file preserves per-tenant state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-tenant-targets-"));
  const file = path.join(dir, "targets.json");

  try {
    const registry = createTenantTargetRegistry();
    registry.forTenant("acme").register(target("gpu"));
    registry.forTenant("beta").register(target("gpu-beta"));
    await registry.saveToFile(file);

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.tenants.acme.length, 1);
    assert.equal(raw.tenants.beta[0].id, "gpu-beta");

    const restored = createTenantTargetRegistry();
    await restored.loadFromFile(file);
    assert.equal(restored.forTenant("acme").has("gpu"), true);
    assert.equal(restored.forTenant("acme").has("gpu-beta"), false);
    assert.equal(restored.forTenant("beta").has("gpu-beta"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued target file saves observe mutations in call order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir, "locd-target-save-race-"));
  const file = path.join(dir, "targets.json");

  try {
    const registry = createTenantTargetRegistry();
    registry.forTenant("acme").register(target("gpu-a"));

    const first = registry.saveToFile(file);
    registry.forTenant("acme").register(target("gpu-b"));
    const second = registry.saveToFile(file);

    await Promise.all([first, second]);

    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(
      raw.tenants.acme.map(item => item.id).sort(),
      ["gpu-a", "gpu-b"]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy target array loads into default tenant", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-tenant-targets-legacy-"));
  const file = path.join(dir, "targets.json");

  try {
    await writeFile(file, JSON.stringify([target("legacy")]), "utf8");
    const registry = createTenantTargetRegistry();
    await registry.loadFromFile(file);
    assert.equal(registry.forTenant("default").has("legacy"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

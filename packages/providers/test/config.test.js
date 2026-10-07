import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createProviderFromConfig,
  createProvidersFromConfig,
  loadProvidersFromFile
} from "../src/index.js";

const env = { PRIVATE_PROVIDER_KEY: "secret" };

const base = {
  id: "private-provider",
  targetId: "private-provider",
  mode: "private",
  baseUrl: "https://inference.example.com",
  apiKeyEnv: "PRIVATE_PROVIDER_KEY",
  model: "demo-model"
};

test("provider config resolves API keys from environment references", async () => {
  const adapter = createProviderFromConfig(base, env, async () => {
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });

  const snapshot = await adapter.getSnapshot();
  assert.equal(snapshot.id, "private-provider");
  assert.equal(snapshot.mode, "private");
});

test("provider config never stores API key in target snapshot", async () => {
  const adapter = createProviderFromConfig(base, env, async () => {
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });

  const probe = await adapter.probe();
  assert.equal("apiKey" in probe, false);
  assert.equal(JSON.stringify(probe).includes("PRIVATE_PROVIDER_KEY"), false);
  assert.equal(JSON.stringify(probe).includes("secret"), false);
});

test("missing API key env is rejected", () => {
  assert.throws(
    () => createProviderFromConfig(base, {}, async () => new Response("{}", { status: 200 })),
    /API key environment variable is not set/
  );
});

test("provider configs are validated before adapter creation", () => {
  assert.throws(
    () => createProviderFromConfig({ ...base, baseUrl: "" }, env),
    /baseUrl is required/
  );
  assert.throws(
    () => createProviderFromConfig({ ...base, mode: "satellite" }, env),
    /provider mode is invalid/
  );
});

test("provider list rejects duplicate IDs", () => {
  assert.throws(
    () => createProvidersFromConfig({ providers: [base, { ...base, targetId: "other" }] }, env),
    /duplicate provider id/
  );
});

test("provider list creates multiple adapters", () => {
  const adapters = createProvidersFromConfig({
    providers: [
      base,
      {
        ...base,
        id: "local-provider",
        targetId: "local-provider",
        mode: "local",
        baseUrl: "http://localhost:11434",
        apiKeyEnv: undefined
      }
    ]
  }, env);

  assert.equal(adapters.length, 2);
  assert.equal(adapters[1].targetId, "local-provider");
});

test("provider config file loader creates adapters from JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-config-"));
  const file = path.join(dir, "providers.json");

  try {
    await writeFile(file, JSON.stringify({ providers: [base] }), "utf8");
    const adapters = await loadProvidersFromFile(file, env, async () => new Response("{}", { status: 200 }));
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].targetId, "private-provider");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing and malformed provider config files fail clearly", async () => {
  await assert.rejects(
    () => loadProvidersFromFile("/tmp/locd-provider-config-does-not-exist.json", env),
    /provider config file not found/
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-config-invalid-"));
  const file = path.join(dir, "providers.json");

  try {
    await writeFile(file, "{not-json}", "utf8");
    await assert.rejects(
      () => loadProvidersFromFile(file, env),
      /provider config file is invalid JSON/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider base URLs cannot embed credentials", () => {
  assert.throws(
    () => createProviderFromConfig({
      ...base,
      baseUrl: "https://user:secret@example.com"
    }, env),
    /embedded credentials/
  );
});

test("blank API key environment values are rejected", () => {
  assert.throws(
    () => createProviderFromConfig(base, { PRIVATE_PROVIDER_KEY: "   " }),
    /API key environment variable is empty/
  );
});

test("provider config can create a native Ollama adapter", () => {
  const adapter = createProviderFromConfig({
    ...base,
    id: "ollama-local",
    targetId: "ollama-local",
    type: "ollama",
    mode: "local",
    baseUrl: "http://localhost:11434/api",
    apiKeyEnv: undefined
  }, env);

  assert.equal(adapter.id, "ollama-local");
  assert.equal(adapter.targetId, "ollama-local");
});

test("provider config rejects unsupported adapter types", () => {
  assert.throws(
    () => createProviderFromConfig({
      ...base,
      type: "unknown-provider"
    }, env),
    /provider type is invalid/
  );
});

test("provider config file can load a native Ollama provider", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locd-provider-ollama-"));
  const file = path.join(dir, "providers.json");

  try {
    await writeFile(file, JSON.stringify({
      providers: [{
        id: "ollama-local",
        targetId: "ollama-local",
        type: "ollama",
        mode: "local",
        baseUrl: "http://localhost:11434/api",
        model: "llama3.2"
      }]
    }), "utf8");

    const adapters = await loadProvidersFromFile(
      file,
      {},
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    );

    assert.equal(adapters.length, 1);
    assert.equal(adapters[0].id, "ollama-local");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider config preserves trusted tenant metadata outside target snapshots", () => {
  const adapter = createProviderFromConfig({
    ...base,
    id: "tenant-provider",
    targetId: "tenant-provider",
    tenantId: "Acme-Prod"
  }, env);

  assert.equal(adapter.tenantId, "acme-prod");
});

test("provider config rejects unsafe tenant identifiers", () => {
  assert.throws(
    () => createProviderFromConfig({
      ...base,
      tenantId: "../escape"
    }, env),
    /tenantId must match/
  );
});

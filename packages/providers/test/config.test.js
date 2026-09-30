import test from "node:test";
import assert from "node:assert/strict";
import { createProviderFromConfig, createProvidersFromConfig } from "../src/index.js";

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
  assert.equal("PRIVATE_PROVIDER_KEY" in JSON.stringify(probe), false);
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

test("HTTP state clients validate and propagate timeout settings", () => {
  const { fetchImpl, calls } = fakeFetch({ value: null });

  assert.throws(
    () => createHTTPDecisionStore({
      baseUrl: "http://state.internal",
      fetchImpl,
      timeoutMs: 0
    }),
    /timeoutMs must be >= 1/
  );

  const stores = createHTTPStateStores({
    baseUrl: "http://state.internal",
    fetchImpl,
    timeoutMs: 1234
  });

  return stores.coordination.get("probe").then(() => {
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.signal.aborted, false);
  });
});

test("HTTP state client maps request timeouts to a stable dependency error", async () => {
  const fetchImpl = async () => {
    const error = new DOMException("timed out", "TimeoutError");
    throw error;
  };
  const store = createHTTPDecisionStore({
    baseUrl: "http://state.internal",
    fetchImpl,
    timeoutMs: 5
  });

  await assert.rejects(
    () => store.summary(),
    error => (
      error.code === "STATE_SERVICE_TIMEOUT" &&
      error.status === 504 &&
      error.message === "state_service_timeout"
    )
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  createHTTPCoordinationStore,
  createHTTPDecisionStore,
  createHTTPPolicyStore,
  createHTTPStateStores
} from "../src/index.js";

function fakeFetch(responseBody, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" }
    });
  };
  return { fetchImpl, calls };
}

test("HTTP coordination applies timeout without dropping request options", async () => {
  const { fetchImpl, calls } = fakeFetch({ value: 42 });
  const store = createHTTPCoordinationStore({
    baseUrl: "http://state.internal:8787",
    apiKey: "secret",
    fetchImpl,
    timeoutMs: 1234
  });

  assert.equal(await store.get("tenant/a"), 42);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
});

test("HTTP coordination client encodes keys and sends auth", async () => {
  const { fetchImpl, calls } = fakeFetch({ value: 42 });
  const store = createHTTPCoordinationStore({
    baseUrl: "http://state.internal:8787",
    apiKey: "secret",
    fetchImpl
  });

  const value = await store.get("tenant/a");
  assert.equal(value, 42);
  assert.equal(calls[0].url, "http://state.internal:8787/v1/state/kv/tenant%2Fa");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret");
});

test("HTTP coordination supports set-if-absent and increment", async () => {
  let index = 0;
  const responses = [
    { claimed: true },
    { value: 3 }
  ];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responses[index++]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const store = createHTTPCoordinationStore({
    baseUrl: "http://state.internal",
    fetchImpl
  });

  assert.equal(await store.setIfAbsent("lock", { owner: 1 }, { ttlMs: 1000 }), true);
  assert.equal(await store.incr("counter", { ttlMs: 1000 }), 3);
  assert.match(calls[0].url, /set-if-absent$/);
  assert.match(calls[1].url, /\/incr$/);
});

test("HTTP telemetry client maps decision and metric responses", async () => {
  const { fetchImpl, calls } = fakeFetch({
    decisions: [{ id: "d-1" }]
  });
  const store = createHTTPDecisionStore({
    baseUrl: "http://state.internal",
    fetchImpl
  });

  await store.record({ id: "d-1", route: "local" });
  const events = await store.list({ limit: 10 });

  assert.match(calls[0].url, /\/v1\/state\/decisions$/);
  assert.deepEqual(events, [{ id: "d-1" }]);
});

test("HTTP policy client maps tenant-scoped CRUD and rollback", async () => {
  let index = 0;
  const responses = [
    { policies: [{ id: "acme-policy" }] },
    { id: "acme-policy", version: 1, policy: { id: "acme-policy" }, versions: [] },
    { id: "acme-policy", versions: [{ version: 1 }] },
    { id: "acme-policy", version: 2, policy: { id: "acme-policy" }, versions: [] },
    { id: "acme-policy", version: 3, policy: { id: "acme-policy" }, versions: [], rolledBackFromVersion: 1 },
    { removed: "acme-policy" }
  ];
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responses[index++]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const store = createHTTPPolicyStore({
    baseUrl: "http://state.internal",
    apiKey: "secret",
    fetchImpl
  });

  assert.deepEqual(await store.list("acme"), [{ id: "acme-policy" }]);
  assert.equal((await store.get("acme", "acme-policy")).version, 1);
  assert.equal((await store.history("acme", "acme-policy")).versions.length, 1);
  assert.equal((await store.upsert(
    "acme",
    { id: "acme-policy", baseProfile: "balanced" },
    { updatedBy: "admin" }
  )).version, 2);
  const rolledBack = await store.rollback("acme", "acme-policy", 1, { updatedBy: "rollback" });
  assert.equal(rolledBack.version, 3);
  assert.equal(rolledBack.rolledBackFromVersion, 1);
  assert.equal(await store.remove("acme", "acme-policy"), true);

  assert.equal(calls.every(call => call.options.headers.authorization === "Bearer secret"), true);
  assert.equal(calls[0].options.headers["x-locd-tenant-id"], "acme");
  assert.match(calls[2].url, /\/history$/);
  assert.match(calls[4].url, /\/acme-policy\/rollback$/);
  assert.match(calls[5].url, /\/acme-policy$/);
});

test("HTTP state client surfaces non-2xx errors", async () => {
  const { fetchImpl } = fakeFetch({ error: "forbidden" }, 403);
  const store = createHTTPCoordinationStore({
    baseUrl: "http://state.internal",
    apiKey: "wrong",
    fetchImpl
  });

  await assert.rejects(
    () => store.get("key"),
    error => error.status === 403 && error.body.error === "forbidden"
  );
});


test("telemetry and coordination clear endpoints stay domain-specific", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ cleared: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const stores = createHTTPStateStores({
    baseUrl: "http://state.internal",
    fetchImpl
  });

  await stores.telemetry.clear();
  await stores.coordination.clear();

  assert.equal(calls[0].url, "http://state.internal/v1/state/telemetry/clear");
  assert.equal(calls[1].url, "http://state.internal/v1/state/coordination/clear");
});

test("HTTP telemetry propagates tenant context to the state service", async () => {
  const { fetchImpl, calls } = fakeFetch({ decisions: [] });

  const store = createHTTPDecisionStore({
    baseUrl: "http://state.internal:8787",
    apiKey: "secret",
    fetchImpl
  });

  await store.record({
    id: "tenant-event",
    tenantId: "acme",
    route: "local"
  });
  await store.recordOutcome(
    "tenant-event",
    { outcome: "success" },
    { tenantId: "acme" }
  );
  await store.list({ tenantId: "acme", limit: 10 });
  await store.summary({ tenantId: "acme" });

  assert.equal(calls[0].options.headers["x-locd-tenant-id"], "acme");
  assert.equal(calls[1].options.headers["x-locd-tenant-id"], "acme");
  assert.equal(calls[2].options.headers["x-locd-tenant-id"], "acme");
  assert.equal(calls[3].options.headers["x-locd-tenant-id"], "acme");
});

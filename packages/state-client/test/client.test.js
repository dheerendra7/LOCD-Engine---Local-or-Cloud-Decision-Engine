import test from "node:test";
import assert from "node:assert/strict";
import {
  createHTTPCoordinationStore,
  createHTTPDecisionStore
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
  assert.match(calls[1].url, //incr$/);
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

  assert.match(calls[0].url, //v1/state/decisions$/);
  assert.deepEqual(events, [{ id: "d-1" }]);
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

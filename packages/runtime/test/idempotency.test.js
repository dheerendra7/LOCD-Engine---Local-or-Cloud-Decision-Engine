import test from "node:test";
import assert from "node:assert/strict";
import { createIdempotencyStore, fingerprint } from "../src/index.js";

test("fingerprint is stable across object key order", () => {
  assert.equal(
    fingerprint({ b: 2, a: { y: 1, x: 0 } }),
    fingerprint({ a: { x: 0, y: 1 }, b: 2 })
  );
});

test("same idempotency key and body replays the stored response", () => {
  const store = createIdempotencyStore();
  store.remember("POST /v1/decide", "abc", { x: 1, y: 2 }, { status: 200, body: { route: "local" } });

  assert.deepEqual(
    store.lookup("POST /v1/decide", "abc", { y: 2, x: 1 }),
    { status: 200, body: { route: "local" }, replayed: true }
  );
});

test("same key with different payload is rejected", () => {
  const store = createIdempotencyStore();
  store.remember("POST /v1/decide", "abc", { x: 1 }, { status: 200, body: {} });

  assert.throws(
    () => store.lookup("POST /v1/decide", "abc", { x: 2 }),
    /idempotency_key_reused/
  );
});

test("keys are scoped by endpoint", () => {
  const store = createIdempotencyStore();
  store.remember("POST /v1/decide", "same", { x: 1 }, { status: 200, body: { a: 1 } });
  assert.equal(
    store.lookup("POST /v1/outcomes", "same", { x: 1 }),
    null
  );
});

test("invalid keys fail closed", () => {
  const store = createIdempotencyStore();
  assert.throws(
    () => store.lookup("/v1/decide", " ".repeat(2), {}),
    /idempotency_key_invalid/
  );
  assert.throws(
    () => store.remember("/v1/decide", "x".repeat(257), {}, {}),
    /idempotency_key_invalid/
  );
});

test("history is bounded", () => {
  const store = createIdempotencyStore({ maxEntries: 2 });
  store.remember("a", "1", {}, {});
  store.remember("b", "2", {}, {});
  store.remember("c", "3", {}, {});
  assert.equal(store.size(), 2);
});


test("claim prevents concurrent duplicate work and supports release", () => {
  const store = createIdempotencyStore();

  assert.deepEqual(
    store.claim("POST /v1/execute", "same", { x: 1 }),
    { claimed: true }
  );

  assert.deepEqual(
    store.claim("POST /v1/execute", "same", { x: 1 }),
    { claimed: false, reason: "in_progress" }
  );

  assert.throws(
    () => store.claim("POST /v1/execute", "same", { x: 2 }),
    /idempotency_key_reused/
  );

  assert.equal(
    store.release("POST /v1/execute", "same", { x: 1 }),
    true
  );

  assert.deepEqual(
    store.claim("POST /v1/execute", "same", { x: 1 }),
    { claimed: true }
  );
});

test("completed claims become replayable through remember", () => {
  const store = createIdempotencyStore();

  assert.equal(store.claim("scope", "key", { x: 1 }).claimed, true);
  store.remember("scope", "key", { x: 1 }, {
    status: 200,
    body: { ok: true }
  });

  assert.deepEqual(
    store.claim("scope", "key", { x: 1 }),
    {
      claimed: false,
      reason: "completed",
      response: { status: 200, body: { ok: true }, replayed: true }
    }
  );
});

test("expired processing claim can be reclaimed", async () => {
  const store = createIdempotencyStore();
  assert.deepEqual(
    store.claim("scope", "key", { x: 1 }, 5),
    { claimed: true }
  );

  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(store.claim("scope", "key", { x: 1 }, 5).claimed, true);
});

test("invalid lock TTL is rejected", () => {
  const store = createIdempotencyStore();
  assert.throws(
    () => store.claim("scope", "key", {}, 0),
    /idempotency_lock_ttl_invalid/
  );
});

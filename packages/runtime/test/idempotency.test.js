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

test("scope and key delimiter characters cannot cause cross-scope replay", () => {
  const store = createIdempotencyStore();
  store.remember(
    "scope:prefix",
    "key",
    { operation: "shared-body" },
    { status: 200, body: { operation: "scope-A" } }
  );

  assert.equal(
    store.lookup("scope", "prefix:key", { operation: "shared-body" }),
    null
  );
  assert.deepEqual(
    store.lookup("scope:prefix", "key", { operation: "shared-body" }),
    { status: 200, body: { operation: "scope-A" }, replayed: true }
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

test("local idempotency claims prevent concurrent duplicate work", () => {
  const store = createIdempotencyStore();

  const firstClaim = store.claim("POST /v1/execute", "same-key", { x: 1 });
  assert.equal(firstClaim.claimed, true);
  assert.equal(typeof firstClaim.claimToken, "string");

  assert.deepEqual(
    store.claim("POST /v1/execute", "same-key", { x: 1 }),
    { claimed: false, reason: "in_progress" }
  );

  assert.throws(
    () => store.claim("POST /v1/execute", "same-key", { x: 2 }),
    /idempotency_key_reused/
  );

  store.remember(
    "POST /v1/execute",
    "same-key",
    { x: 1 },
    { status: 200, body: { executionId: "e-1" } }
  );

  assert.deepEqual(
    store.claim("POST /v1/execute", "same-key", { x: 1 }),
    {
      claimed: false,
      reason: "completed",
      response: {
        status: 200,
        body: { executionId: "e-1" },
        replayed: true
      }
    }
  );
});

test("invalid local idempotency lock TTL fails clearly", () => {
  const store = createIdempotencyStore();
  assert.throws(
    () => store.claim("scope", "key", {}, 0),
    /idempotency_lock_ttl_invalid/
  );
});

test("processing claims expire using their own lock TTL", () => {
  let now = 1000;
  const store = createIdempotencyStore({
    ttlMs: 60000,
    clock: () => now
  });

  assert.equal(store.claim("scope", "key", { x: 1 }, 100).claimed, true);

  now = 1050;
  assert.deepEqual(
    store.claim("scope", "key", { x: 1 }, 100),
    { claimed: false, reason: "in_progress" }
  );

  now = 1100;
  assert.equal(store.claim("scope", "key", { x: 1 }, 100).claimed, true);
});

test("completed responses keep the normal retention TTL", () => {
  let now = 1000;
  const store = createIdempotencyStore({
    ttlMs: 100,
    clock: () => now
  });

  store.remember("scope", "key", { x: 1 }, { status: 200, body: {} });

  now = 1099;
  assert.notEqual(store.lookup("scope", "key", { x: 1 }), null);

  now = 1100;
  assert.equal(store.lookup("scope", "key", { x: 1 }), null);
});


test("fingerprints preserve JSON own properties named __proto__", () => {
  const reader = JSON.parse('{"role":"reader","__proto__":{"admin":false}}');
  const admin = JSON.parse('{"role":"reader","__proto__":{"admin":true}}');
  assert.notEqual(fingerprint(reader), fingerprint(admin));
  assert.equal(
    fingerprint(reader),
    fingerprint(JSON.parse('{"__proto__":{"admin":false},"role":"reader"}'))
  );
});

test("idempotency rejects a different payload hidden behind __proto__", () => {
  const store = createIdempotencyStore();
  const reader = JSON.parse('{"role":"reader","__proto__":{"admin":false}}');
  const admin = JSON.parse('{"role":"reader","__proto__":{"admin":true}}');
  store.remember("POST /v1/execute", "proto-key", reader, { status: 200, body: { ok: true } });
  assert.throws(
    () => store.lookup("POST /v1/execute", "proto-key", admin),
    /idempotency_key_reused/
  );
});


test("cached idempotency responses cannot be mutated through caller-owned objects", () => {
  const store = createIdempotencyStore();
  const response = {
    status: 200,
    body: { result: { targetId: "safe" } }
  };
  store.remember("POST /v1/decide", "immutable-response", { x: 1 }, response);

  response.body.result.targetId = "mutated-before-replay";
  const firstReplay = store.lookup("POST /v1/decide", "immutable-response", { x: 1 });
  assert.equal(firstReplay.body.result.targetId, "safe");

  firstReplay.body.result.targetId = "mutated-after-replay";
  const secondReplay = store.claim("POST /v1/decide", "immutable-response", { x: 1 });
  assert.equal(secondReplay.response.body.result.targetId, "safe");
});


test("local idempotency releases only its own unfinished claim", () => {
  const store = createIdempotencyStore();
  const body = { payload: "same" };
  const claim = store.claim("scope", "key", body);
  assert.equal(claim.claimed, true);
  assert.equal(store.release("scope", "key", body, claim.claimToken + "-wrong"), false);
  assert.equal(store.claim("scope", "key", body).reason, "in_progress");
  assert.equal(store.release("scope", "key", body, claim.claimToken), true);
  const replacement = store.claim("scope", "key", body);
  assert.equal(replacement.claimed, true);
  assert.equal(store.release("scope", "key", body, claim.claimToken), false);
  assert.equal(store.claim("scope", "key", body).reason, "in_progress");
});


test("a stale local request cannot complete a replacement claim", () => {
  let now = 1_000;
  const store = createIdempotencyStore({ ttlMs: 1_000, clock: () => now });
  const body = { payload: "same" };
  const oldClaim = store.claim("scope", "key", body, 100);
  now = 1_100;
  const newClaim = store.claim("scope", "key", body, 100);
  assert.equal(newClaim.claimed, true);
  assert.notEqual(newClaim.claimToken, oldClaim.claimToken);

  assert.equal(
    store.remember("scope", "key", body, { status: 200, body: { owner: "old" } }, oldClaim.claimToken),
    false
  );
  assert.equal(store.claim("scope", "key", body).reason, "in_progress");
  assert.equal(
    store.remember("scope", "key", body, { status: 200, body: { owner: "new" } }, newClaim.claimToken),
    true
  );
  assert.equal(store.lookup("scope", "key", body).body.owner, "new");
});


test("expired local claim caches its result only when no replacement owner exists", () => {
  let now = 1_000;
  const store = createIdempotencyStore({ ttlMs: 1_000, clock: () => now });
  const body = { payload: "slow but successful" };
  const expired = store.claim("scope", "expired", body, 100);

  now = 1_101;
  assert.equal(
    store.remember("scope", "expired", body, { status: 200, body: { result: "ok" } }, expired.claimToken),
    true
  );
  assert.equal(store.lookup("scope", "expired", body).body.result, "ok");

  const oldClaim = store.claim("scope", "replacement", body, 100);
  now += 101;
  const newClaim = store.claim("scope", "replacement", body, 100);
  assert.equal(newClaim.claimed, true);
  assert.equal(
    store.remember("scope", "replacement", body, { status: 200, body: { result: "stale" } }, oldClaim.claimToken),
    false
  );
  assert.equal(store.claim("scope", "replacement", body).reason, "in_progress");
});


test("lookup does not return a replay before the claimed request completes", () => {
  const store = createIdempotencyStore();
  const body = { operation: "write" };
  const claim = store.claim("POST /resource", "key-processing", body);
  assert.equal(claim.claimed, true);
  assert.equal(store.lookup("POST /resource", "key-processing", body), null);

  assert.equal(
    store.remember("POST /resource", "key-processing", body, { status: 201, body: { id: "created" } }, claim.claimToken),
    true
  );
  assert.deepEqual(
    store.lookup("POST /resource", "key-processing", body),
    { status: 201, body: { id: "created" }, replayed: true }
  );
});
